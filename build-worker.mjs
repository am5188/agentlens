// build-worker.mjs — 生成 Cloudflare Worker 部署产物
//
// 产出:
//   worker/data/index.json   市场索引（含每个 Agent 的信任分）
//   worker/data/trust.json   每个 Agent 的服务明细 + 评价分布（供 /trust 使用）
//   worker/public/index.html 看板
//
// 用法: node agentlens/build-worker.mjs

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "agentlens", "data");
const W = path.join(ROOT, "agentlens", "worker");
fs.mkdirSync(path.join(W, "data"), { recursive: true });
fs.mkdirSync(path.join(W, "public"), { recursive: true });

const index = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
const raw = fs
  .readFileSync(path.join(DATA, "agents.ndjson"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const trust = {};
for (const a of raw) {
  trust[String(a.agentId)] = {
    services: (a.services || []).map((s) => ({
      serviceId: s.serviceId,
      name: s.name,
      price: s.price,
      priceInterval: s.priceInterval,
      serviceType: s.serviceType,
      freeTrial: s.freeTrial,
      symbol: s.symbol,
    })),
    reviewDistribution: a.reviewSummary?.distribution || null,
    description: (a.description || "").slice(0, 400),
  };
}

fs.writeFileSync(path.join(W, "data", "index.json"), JSON.stringify(index));
fs.writeFileSync(path.join(W, "data", "trust.json"), JSON.stringify(trust));
const html = fs.readFileSync(path.join(ROOT, "agentlens", "public", "index.html"), "utf8");
fs.copyFileSync(
  path.join(ROOT, "agentlens", "public", "index.html"),
  path.join(W, "public", "index.html")
);
fs.writeFileSync(path.join(W, "public-html.js"), "export default " + JSON.stringify(html) + ";\n");

const sz = (p) => (fs.statSync(p).size / 1024).toFixed(0) + " KB";
console.log("worker/data/index.json  ", sz(path.join(W, "data", "index.json")));
console.log("worker/data/trust.json  ", sz(path.join(W, "data", "trust.json")));
console.log("worker/public/index.html", sz(path.join(W, "public", "index.html")));
console.log(`agents=${index.summary.agentCount} services=${index.summary.serviceCount}`);
