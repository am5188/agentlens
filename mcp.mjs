#!/usr/bin/env node
// mcp.mjs — AgentLens MCP server (stdio transport, zero dependencies)
//
// 让任何支持 MCP 的 Agent 直接调用 AgentLens：
//   tools: market_overview / price_benchmark / rank_agents / trust_lookup / compare_agents / recommend_agent
//
// 注册到 Claude Code:
//   claude mcp add agentlens -- node D:\Projects\am\web3\agentlens\mcp.mjs
// 或 Codex / 其他: command = node, args = ["<此文件绝对路径>"]
//
// 环境变量:
//   AGENTLENS_BASE  默认 https://agentlens.am518.uk
//   AGENTLENS_PAYMENT  可选，x402 结算交易哈希（用于付费工具）

import readline from "node:readline";

const BASE = process.env.AGENTLENS_BASE || "https://agentlens.am518.uk";
const PAYMENT = process.env.AGENTLENS_PAYMENT || "";

const TOOLS = [
  {
    name: "market_overview",
    description:
      "Market-wide stats for the OKX.AI agent marketplace: number of agents and services, total deliveries, review counts, how many agents have never delivered, and price percentiles per call and per month. Free.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "price_benchmark",
    description:
      "Fair-price percentiles (p10/p25/median/p75/p90/max) for a marketplace category, so an agent can tell whether a quoted price is normal. Free.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Optional category: SOFTWARE_SERVICES, FINANCE, LIFESTYLE, TRADING, ART_CREATION, OTHER. Omit for the global benchmark.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rank_agents",
    description:
      "Ranked supply list of agent services by AgentLens trust score, with rating, review count, deliveries and price verdict. Free.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional category filter." },
        limit: { type: "number", description: "How many to return (default 25, max 100)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "trust_lookup",
    description:
      "Full trust record for one agent: composite trust score with its components (rating, delivery, approval, liveness, freshness), shrunk rating, confidence level, every listed service with price and interval, review distribution, and the category price benchmark. Paid: 0.002 USDT per call via x402.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", description: "OKX.AI agent id, e.g. 8136." } },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_agents",
    description:
      "Head-to-head comparison of two agents on trust, rating, review count, deliveries and price verdict. Paid: 0.005 USDT per call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "First agent id." },
        b: { type: "string", description: "Second agent id." },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "recommend_agent",
    description:
      "Recommend the best agents for a task: filter by category, minimum trust, maximum per-call price and online status, then rank by trust. Returns why each candidate qualifies plus the category price benchmark. Paid: 0.01 USDT per call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category filter." },
        minTrust: { type: "number", description: "Minimum trust score 0-100." },
        maxPrice: { type: "number", description: "Maximum per-call price in USDT." },
        requireOnline: { type: "boolean", description: "Only currently online agents." },
        limit: { type: "number", description: "How many recommendations (default 5)." },
      },
      additionalProperties: false,
    },
  },
];

async function callApi(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (PAYMENT) headers["X-PAYMENT"] = PAYMENT;
  const res = await fetch(BASE + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleTool(name, args) {
  if (name === "market_overview") return await callApi("/market");
  if (name === "price_benchmark")
    return await callApi("/price" + (args.category ? `?category=${encodeURIComponent(args.category)}` : ""));
  if (name === "rank_agents") {
    const q = new URLSearchParams();
    if (args.category) q.set("category", args.category);
    q.set("limit", String(args.limit || 25));
    return await callApi("/agents?" + q.toString());
  }
  if (name === "trust_lookup") return await callApi(`/trust/${encodeURIComponent(args.agentId)}`);
  if (name === "compare_agents")
    return await callApi(`/compare?a=${encodeURIComponent(args.a)}&b=${encodeURIComponent(args.b)}`);
  if (name === "recommend_agent")
    return await callApi("/recommend", { method: "POST", body: JSON.stringify(args) });
  throw new Error("unknown tool: " + name);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      process.stdout.write(
        JSON.stringify(
          ok(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agentlens", version: "0.1.0" },
          })
        ) + "\n"
      );
    } else if (method === "notifications/initialized" || method === "initialized") {
      // notification, no reply
    } else if (method === "tools/list") {
      process.stdout.write(JSON.stringify(ok(id, { tools: TOOLS })) + "\n");
    } else if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      const { status, body } = await handleTool(name, args);
      if (status === 402) {
        process.stdout.write(
          JSON.stringify(
            ok(id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    "Payment required (HTTP 402). AgentLens is an x402 service on X Layer.\n" +
                    JSON.stringify(body, null, 1) +
                    "\n\nPay the exact USDT amount to payTo, then call again with the settlement transaction hash set in AGENTLENS_PAYMENT.",
                },
              ],
            })
          ) + "\n"
        );
      } else {
        process.stdout.write(
          JSON.stringify(
            ok(id, { content: [{ type: "text", text: JSON.stringify(body, null, 1) }] })
          ) + "\n"
        );
      }
    } else if (method === "ping") {
      process.stdout.write(JSON.stringify(ok(id, {})) + "\n");
    } else if (id != null) {
      process.stdout.write(JSON.stringify(err(id, -32601, "method not found: " + method)) + "\n");
    }
  } catch (e) {
    if (id != null) process.stdout.write(JSON.stringify(err(id, -32603, String(e.message || e))) + "\n");
  }
});

process.stderr.write(`agentlens MCP server ready (base=${BASE})\n`);
