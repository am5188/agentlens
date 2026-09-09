// server.mjs — AgentLens API：Agent 商业的信任与定价预言机
//
// 免费层:  GET /health  /market  /price  /agents
// 付费层:  GET /trust/:id  /compare  POST /recommend   （x402，USDT on X Layer）
//
// x402 流程（HTTP 402）：
//   1) 无支付凭证 → 402 + accepts[]（含 payTo / asset / maxAmountRequired / network）
//   2) 客户端付款后重试，带 X-PAYMENT: <txHash>
//   3) 服务端用 X Layer RPC 校验：tx 成功 + 向 payTo 转账 USDT ≥ 要求金额 + 时间窗口内
//
// 用法: node agentlens/server.mjs  [PORT=8788] [PAY_TO=0x...]

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "agentlens", "data");
const PORT = Number(process.env.PORT || 8788);
const PAY_TO = process.env.PAY_TO || "0x0000000000000000000000000000000000000000";
const XLAYER_RPC = process.env.XLAYER_RPC || "https://rpc.xlayer.tech";
const USDT_XLAYER = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const NETWORK = "eip155:196"; // X Layer

const index = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
const byId = new Map(index.agents.map((a) => [String(a.agentId), a]));
const rawById = new Map(
  fs
    .readFileSync(path.join(DATA, "agents.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((a) => [String(a.agentId), a])
);

// ---------- 价格表（每次调用，单位 USDT 的最小单位 6 位小数） ----------
const PRICES = {
  "GET /trust": "2000", // 0.002 USDT
  "GET /compare": "5000", // 0.005 USDT
  "POST /recommend": "10000", // 0.01 USDT
};

// ---------- x402 校验 ----------
async function rpc(method, params) {
  const res = await fetch(XLAYER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function verifyX402(txHash, amountRequired, payTo) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "bad tx hash" };
  if (payTo === "0x" + "0".repeat(40)) return { ok: false, reason: "server payTo not configured" };
  const [tx, receipt] = await Promise.all([
    rpc("eth_getTransactionByHash", [txHash]),
    rpc("eth_getTransactionReceipt", [txHash]),
  ]);
  if (!tx) return { ok: false, reason: "tx not found" };
  if (!receipt || receipt.status !== "0x1") return { ok: false, reason: "tx not successful" };

  // 检查 receipt logs 里是否有 USDT Transfer 到 payTo 且金额足够
  const wantTo = payTo.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  let paid = 0n;
  for (const lg of receipt.logs || []) {
    if ((lg.address || "").toLowerCase() !== USDT_XLAYER) continue;
    if ((lg.topics || [])[0] !== TRANSFER_TOPIC) continue;
    const to = (lg.topics || [])[2] || "";
    if (to.toLowerCase() !== "0x" + wantTo) continue;
    paid += BigInt(lg.data === "0x" ? "0x0" : lg.data);
  }
  if (paid < BigInt(amountRequired)) {
    return { ok: false, reason: `paid ${paid} < required ${amountRequired}` };
  }
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const ts = block ? Number(BigInt(block.timestamp)) * 1000 : 0;
  if (ts && Date.now() - ts > 30 * 60 * 1000) return { ok: false, reason: "payment too old" };
  return { ok: true, paid: paid.toString(), ts };
}

// ---------- 推荐算法 ----------
function recommend({ category, maxMonthlyPrice, minTrust, requireOnline, limit = 5 }) {
  let list = index.agents;
  if (category) list = list.filter((a) => a.category === category);
  if (minTrust != null) list = list.filter((a) => a.trust >= minTrust);
  if (requireOnline) list = list.filter((a) => a.onlineStatus === 1);
  if (maxMonthlyPrice != null)
    list = list.filter((a) => a.lowestMonthlyPrice == null || a.lowestMonthlyPrice <= maxMonthlyPrice);

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
      lowestMonthlyPrice: a.lowestMonthlyPrice,
      priceVerdict: a.priceVerdictPerCall,
      why: `${a.confidence} confidence (${a.reviewCount} reviews), ${a.usageCount} deliveries, price=${a.priceVerdictPerCall}`,
    }))
    .sort((x, y) => y.trust - x.trust)
    .slice(0, limit);
}

// ---------- HTTP ----------
const send = (res, code, body, headers = {}) => {
  const s = JSON.stringify(body, null, 1);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,X-PAYMENT",
    ...headers,
  });
  res.end(s);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return send(res, 204, {});

  try {
    if (p === "/" || p === "/index.html") {
      const html = fs.readFileSync(path.join(process.cwd(), "agentlens", "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end(html);
    }

    if (p === "/health") {
      return send(res, 200, {
        ok: true,
        name: "AgentLens",
        version: "0.1.0",
        network: NETWORK,
        payTo: PAY_TO,
        dataGeneratedAt: index.summary.generatedAt,
        agents: index.summary.agentCount,
        services: index.summary.serviceCount,
      });
    }

    if (p === "/market") return send(res, 200, index.summary);

    if (p === "/price") {
      const cat = url.searchParams.get("category");
      if (cat)
        return send(res, 200, {
          category: cat,
          benchmark: index.summary.priceBenchByCategory[cat] || null,
          global: index.summary.marketPriceBench,
        });
      return send(res, 200, {
        global: index.summary.marketPriceBench,
        byCategory: index.summary.priceBenchByCategory,
      });
    }

    if (p === "/agents") {
      const cat = url.searchParams.get("category");
      const limit = Math.min(100, Number(url.searchParams.get("limit") || 25));
      let list = index.agents;
      if (cat) list = list.filter((a) => a.category === cat);
      return send(res, 200, {
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

    // ---------- 付费端点 ----------
    const isTrust = p.startsWith("/trust/");
    const isCompare = p === "/compare";
    const isRecommend = p === "/recommend";
    if (isTrust || isCompare || isRecommend) {
      const key = isTrust ? "GET /trust" : isCompare ? "GET /compare" : "POST /recommend";
      const price = PRICES[key];
      const payment = req.headers["x-payment"];

      if (!payment) {
        return send(
          res,
          402,
          {
            error: "payment required",
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: NETWORK,
                maxAmountRequired: price,
                resource: `http://127.0.0.1:${PORT}${p}`,
                description: key,
                mimeType: "application/json",
                payTo: PAY_TO,
                asset: USDT_XLAYER,
                assetSymbol: "USDT",
                maxTimeoutSeconds: 60,
              },
            ],
            hint: "Pay the exact USDT amount on X Layer, then retry with header X-PAYMENT: <txHash>",
          },
          { "X-PAYMENT-REQUIRED": "1" }
        );
      }

      let check;
      try {
        check = await verifyX402(payment, price, PAY_TO);
      } catch (e) {
        check = { ok: false, reason: "rpc error: " + e.message };
      }
      if (!check.ok) return send(res, 402, { error: "invalid payment", reason: check.reason });
      res.setHeader("X-PAYMENT-RESPONSE", JSON.stringify({ ok: true, paid: check.paid }));
    }

    if (isTrust) {
      const id = p.split("/")[2];
      const a = byId.get(String(id));
      if (!a) return send(res, 404, { error: "agent not found", agentId: id });
      const raw = rawById.get(String(id)) || {};
      return send(res, 200, {
        ...a,
        services: (raw.services || []).map((s) => ({
          serviceId: s.serviceId,
          name: s.name,
          price: s.price,
          priceInterval: s.priceInterval,
          salesCount: s.salesCount,
          serviceType: s.serviceType,
          freeTrial: s.freeTrial,
        })),
        reviewDistribution: raw.reviewSummary?.distribution || null,
        marketBenchmark: index.summary.priceBenchByCategory[a.category] || null,
      });
    }

    if (isCompare) {
      const a = byId.get(String(url.searchParams.get("a")));
      const b = byId.get(String(url.searchParams.get("b")));
      if (!a || !b) return send(res, 404, { error: "need valid a & b agent ids" });
      const pick = (x) => ({
        agentId: x.agentId,
        name: x.name,
        trust: x.trust,
        score: x.score,
        reviewCount: x.reviewCount,
        usageCount: x.usageCount,
        lowestPerCallPrice: x.lowestPerCallPrice,
        lowestMonthlyPrice: x.lowestMonthlyPrice,
        priceVerdict: x.priceVerdictPerCall,
      });
      const winner = a.trust >= b.trust ? a.agentId : b.agentId;
      return send(res, 200, { a: pick(a), b: pick(b), higherTrust: winner });
    }

    if (isRecommend) {
      let body = {};
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          body = {};
        }
      } else {
        body = Object.fromEntries(url.searchParams);
      }
      const result = recommend({
        category: body.category,
        maxMonthlyPrice: body.maxMonthlyPrice != null ? Number(body.maxMonthlyPrice) : null,
        minTrust: body.minTrust != null ? Number(body.minTrust) : null,
        requireOnline: body.requireOnline === true || body.requireOnline === "true",
        limit: body.limit ? Number(body.limit) : 5,
      });
      return send(res, 200, {
        query: body,
        count: result.length,
        recommendations: result,
        marketBenchmark: body.category
          ? index.summary.priceBenchByCategory[body.category] || null
          : index.summary.marketPriceBench,
      });
    }

    send(res, 404, { error: "not found", endpoints: ["/health", "/market", "/price", "/agents", "/trust/:id", "/compare", "/recommend"] });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AgentLens API → http://127.0.0.1:${PORT}`);
  console.log(`  免费: /health /market /price /agents`);
  console.log(`  x402: /trust/:id  /compare  /recommend  (payTo=${PAY_TO})`);
  console.log(`  数据: ${index.summary.agentCount} agents / ${index.summary.serviceCount} services`);
});
