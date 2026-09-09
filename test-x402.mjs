// test-x402.mjs — 用 X Layer 上真实的 USDT 转账交易验证 x402 支付校验逻辑
//
// 思路：链上找一笔真实 USDT Transfer → 把本地服务端 PAY_TO 临时设为该笔转账的收款地址
//       → 带 X-PAYMENT=<txHash> 调用付费端点，应当返回 200（金额足够时）
//       → 再把 PAY_TO 换成别的地址，应当返回 402（收款人不匹配）
//
// 用法: node agentlens/test-x402.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";

const RPC = "https://rpc.xlayer.tech";
const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PORT = 8791;

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("1) 拉取 X Layer 最新区块…");
const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
console.log("   latest block:", latest);

console.log("2) 查找最近的 USDT Transfer 日志（RPC 限制每次最多 100 个区块）…");
let found = null;
for (let i = 0; i < 40 && !found; i++) {
  const to = latest - i * 100;
  const from = to - 99;
  let logs = [];
  try {
    logs = await rpc("eth_getLogs", [
      {
        address: USDT,
        topics: [TRANSFER],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      },
    ]);
  } catch (e) {
    console.log(`   window ${from}-${to}: ${e.message}`);
    continue;
  }
  for (const lg of logs || []) {
    const recipient = "0x" + (lg.topics[2] || "").slice(26);
    const value = BigInt(lg.data === "0x" ? "0x0" : lg.data);
    if (value >= 2000n) {
      found = { txHash: lg.transactionHash, to: recipient, value, block: Number(BigInt(lg.blockNumber)) };
      break;
    }
  }
  if (i % 5 === 0 || found) console.log(`   窗口 ${from}-${to}: ${(logs || []).length} 条${found ? " → 命中" : ""}`);
}
if (!found) {
  console.log("未找到可用的 USDT 转账日志，跳过");
  process.exit(1);
}
console.log("   交易:", found.txHash);
console.log("   收款:", found.to, " 金额:", found.value.toString(), "base units");

function startServer(payTo) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["agentlens/server.mjs"], {
      env: { ...process.env, PORT: String(PORT), PAY_TO: payTo },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("AgentLens API")) resolve(p);
    });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("error", reject);
    setTimeout(() => reject(new Error("server start timeout")), 15000);
  });
}

async function callTrust(txHash) {
  const r = await fetch(`http://127.0.0.1:${PORT}/trust/8136`, { headers: { "X-PAYMENT": txHash } });
  const body = await r.json();
  return { status: r.status, body };
}

// ---- 用例 A：PAY_TO 等于该笔转账的收款地址 → 应通过 ----
console.log("\n3) 用例 A：PAY_TO = 该笔转账收款地址（应 200）");
let srv = await startServer(found.to);
await sleep(500);
let a = await callTrust(found.txHash);
console.log("   HTTP", a.status, "|", a.status === 200 ? `name=${a.body.name} trust=${a.body.trust}` : JSON.stringify(a.body).slice(0, 160));
srv.kill();
await sleep(600);

// ---- 用例 B：PAY_TO 换成别的地址 → 应拒绝 ----
console.log("\n4) 用例 B：PAY_TO = 另一个地址（应 402，收款人不匹配）");
srv = await startServer("0x1111111111111111111111111111111111111111");
await sleep(500);
let b = await callTrust(found.txHash);
console.log("   HTTP", b.status, "|", JSON.stringify(b.body).slice(0, 160));
srv.kill();
await sleep(600);

// ---- 用例 C：伪造交易哈希 → 应拒绝 ----
console.log("\n5) 用例 C：伪造交易哈希（应 402）");
srv = await startServer(found.to);
await sleep(500);
let c = await callTrust("0x" + "ab".repeat(32));
console.log("   HTTP", c.status, "|", JSON.stringify(c.body).slice(0, 160));
srv.kill();

console.log("\n===== 结论 =====");
console.log("A 真实转账 + 正确收款地址 →", a.status === 200 ? "通过 ✅（链上校验成功）" : "失败 ❌");
console.log("B 真实转账 + 错误收款地址 →", b.status === 402 ? "拒绝 ✅" : "失败 ❌");
console.log("C 伪造哈希 →", c.status === 402 ? "拒绝 ✅" : "失败 ❌");

fs.writeFileSync(
  "agentlens/data/x402-test.json",
  JSON.stringify({ testedAt: new Date().toISOString(), transfer: { ...found, value: found.value.toString() }, A: a.status, B: b.status, C: c.status }, null, 1)
);
process.exit(0);
