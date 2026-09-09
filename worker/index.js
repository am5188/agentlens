// AgentLens — Cloudflare Worker
// Trust & price oracle for the OKX.AI agent economy.
//
// 免费:  GET /  /health  /market  /price  /agents
// x402:  GET /trust/:id   GET /compare?a=&b=   POST /recommend
//
// 付费校验在链上完成：读取 X Layer 交易回执，确认向 payTo 转账了足额 USDT。

import INDEX from "./data/index.json";
import TRUST from "./data/trust.json";
import HTML from "./public-html.js";
import SOURCE_HTML from "./source-html.js";
import SOURCE_TAR from "./source-tar.js";

const USDT_XLAYER = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const NETWORK = "eip155:196";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PRICES = { trust: "2000", compare: "5000", recommend: "10000" };

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,X-PAYMENT",
      "Cache-Control": "public, max-age=60",
      ...extra,
    },
  });

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function verifyPayment(env, txHash, amountRequired, payTo) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "bad tx hash" };
  const rpcurl = env.XLAYER_RPC || "https://rpc.xlayer.tech";
  const receipt = await rpc(rpcurl, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { ok: false, reason: "tx not found" };
  if (receipt.status !== "0x1") return { ok: false, reason: "tx failed" };

  const wantTo = payTo.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  let paid = 0n;
  for (const lg of receipt.logs || []) {
    if ((lg.address || "").toLowerCase() !== USDT_XLAYER) continue;
    if ((lg.topics || [])[0] !== TRANSFER_TOPIC) continue;
    if (((lg.topics || [])[2] || "").toLowerCase() !== "0x" + wantTo) continue;
    paid += BigInt(lg.data === "0x" ? "0x0" : lg.data);
  }
  if (paid < BigInt(amountRequired))
    return { ok: false, reason: `paid ${paid} < required ${amountRequired}` };

  const block = await rpc(rpcurl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  const ts = block ? Number(BigInt(block.timestamp)) * 1000 : 0;
  if (ts && Date.now() - ts > 30 * 60 * 1000) return { ok: false, reason: "payment too old" };
  return { ok: true, paid: paid.toString() };
}

function recommend({ category, maxMonthlyPrice, minTrust, requireOnline, limit = 5 }) {
  let list = INDEX.agents;
  if (category) list = list.filter((a) => a.category === category);
  if (minTrust != null) list = list.filter((a) => a.trust >= minTrust);
  if (requireOnline) list = list.filter((a) => a.onlineStatus === 1);
  if (maxMonthlyPrice != null)
    list = list.filter(
      (a) => a.lowestPerCallPrice == null || a.lowestPerCallPrice <= maxMonthlyPrice
    );
  return list
    .map((a) => ({
      agentId: a.agentId,
      name: a.name,
      category: a.category,
      trust: a.trust,
      score: a.score,
      reviewCount: a.reviewCount,
      confidence: a.confidence,
      usageCount: a.usageCount,
      lowestPerCallPrice: a.lowestPerCallPrice,
      priceVerdict: a.priceVerdictPerCall,
      why: `${a.confidence} confidence (${a.reviewCount} reviews), ${a.usageCount} deliveries, price=${a.priceVerdictPerCall}`,
    }))
    .sort((x, y) => y.trust - x.trust)
    .slice(0, limit);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type,X-PAYMENT",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
      });

    const PAY_TO = env.PAY_TO || "0x0000000000000000000000000000000000000000";

    try {
      if (p === "/" || p === "/index.html")
        return new Response(HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
        });

      if (p === "/source")
        return new Response(SOURCE_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
        });

      if (p === "/source.tar.gz") {
        const bin = atob(SOURCE_TAR);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, {
          headers: {
            "Content-Type": "application/gzip",
            "Content-Disposition": 'attachment; filename="agentlens-source.tar.gz"',
            "Cache-Control": "public, max-age=300",
          },
        });
      }

      if (p === "/health")
        return json({
          ok: true,
          name: "AgentLens",
          version: "0.1.0",
          network: NETWORK,
          payTo: PAY_TO,
          dataGeneratedAt: INDEX.summary.generatedAt,
          agents: INDEX.summary.agentCount,
          services: INDEX.summary.serviceCount,
        });

      if (p === "/market") return json(INDEX.summary);

      if (p === "/price") {
        const cat = url.searchParams.get("category");
        if (cat)
          return json({
            category: cat,
            benchmark: INDEX.summary.priceBenchByCategory[cat] || null,
            global: INDEX.summary.marketPriceBench,
          });
        return json({
          global: INDEX.summary.marketPriceBench,
          byCategory: INDEX.summary.priceBenchByCategory,
        });
      }

      if (p === "/agents") {
        const cat = url.searchParams.get("category");
        const limit = Math.min(100, Number(url.searchParams.get("limit") || 25));
        let list = INDEX.agents;
        if (cat) list = list.filter((a) => a.category === cat);
        return json({
          total: list.length,
          returned: Math.min(limit, list.length),
          agents: list.slice(0, limit).map((a) => ({
            agentId: a.agentId,
            name: a.name,
            category: a.category,
            trust: a.trust,
            score: a.score,
            reviewCount: a.reviewCount,
            usageCount: a.usageCount,
            lowestPerCallPrice: a.lowestPerCallPrice,
            lowestMonthlyPrice: a.lowestMonthlyPrice,
            priceVerdictPerCall: a.priceVerdictPerCall,
            onlineStatus: a.onlineStatus,
          })),
        });
      }

      // ---- x402 付费端点 ----
      const isTrust = p.startsWith("/trust/");
      const isCompare = p === "/compare";
      const isRecommend = p === "/recommend";
      if (isTrust || isCompare || isRecommend) {
        const key = isTrust ? "trust" : isCompare ? "compare" : "recommend";
        const price = PRICES[key];
        const payment = req.headers.get("X-PAYMENT");

        if (!payment) {
          return json(
            {
              error: "payment required",
              x402Version: 1,
              accepts: [
                {
                  scheme: "exact",
                  network: NETWORK,
                  maxAmountRequired: price,
                  resource: url.toString(),
                  description: `AgentLens /${key}`,
                  mimeType: "application/json",
                  payTo: PAY_TO,
                  asset: USDT_XLAYER,
                  assetSymbol: "USDT",
                  maxTimeoutSeconds: 60,
                },
              ],
              hint: "Pay the exact USDT amount on X Layer, then retry with header X-PAYMENT: <txHash>",
            },
            402,
            { "X-PAYMENT-REQUIRED": "1" }
          );
        }

        let check;
        try {
          check = await verifyPayment(env, payment, price, PAY_TO);
        } catch (e) {
          check = { ok: false, reason: "rpc error: " + e.message };
        }
        if (!check.ok) return json({ error: "invalid payment", reason: check.reason }, 402);

        const paidHeader = { "X-PAYMENT-RESPONSE": JSON.stringify({ ok: true, paid: check.paid }) };

        if (isTrust) {
          const id = p.split("/")[2];
          const a = INDEX.agents.find((x) => String(x.agentId) === String(id));
          if (!a) return json({ error: "agent not found", agentId: id }, 404);
          const t = TRUST[String(id)] || {};
          return json(
            {
              ...a,
              services: t.services || [],
              reviewDistribution: t.reviewDistribution || null,
              description: t.description || null,
              marketBenchmark: INDEX.summary.priceBenchByCategory[a.category] || null,
            },
            200,
            paidHeader
          );
        }

        if (isCompare) {
          const a = INDEX.agents.find((x) => String(x.agentId) === String(url.searchParams.get("a")));
          const b = INDEX.agents.find((x) => String(x.agentId) === String(url.searchParams.get("b")));
          if (!a || !b) return json({ error: "need valid a & b agent ids" }, 404);
          const pick = (x) => ({
            agentId: x.agentId,
            name: x.name,
            trust: x.trust,
            score: x.score,
            reviewCount: x.reviewCount,
            usageCount: x.usageCount,
            lowestPerCallPrice: x.lowestPerCallPrice,
            priceVerdict: x.priceVerdictPerCall,
          });
          return json(
            { a: pick(a), b: pick(b), higherTrust: a.trust >= b.trust ? a.agentId : b.agentId },
            200,
            paidHeader
          );
        }

        let body = {};
        if (req.method === "POST") {
          try {
            body = await req.json();
          } catch {
            body = {};
          }
        } else body = Object.fromEntries(url.searchParams);
        const result = recommend({
          category: body.category,
          maxMonthlyPrice: body.maxMonthlyPrice != null ? Number(body.maxMonthlyPrice) : null,
          minTrust: body.minTrust != null ? Number(body.minTrust) : null,
          requireOnline: body.requireOnline === true || body.requireOnline === "true",
          limit: body.limit ? Number(body.limit) : 5,
        });
        return json(
          {
            query: body,
            count: result.length,
            recommendations: result,
            marketBenchmark: body.category
              ? INDEX.summary.priceBenchByCategory[body.category] || null
              : INDEX.summary.marketPriceBench,
          },
          200,
          paidHeader
        );
      }

      return json(
        {
          error: "not found",
          endpoints: ["/health", "/market", "/price", "/agents", "/trust/:id", "/compare", "/recommend"],
        },
        404
      );
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
