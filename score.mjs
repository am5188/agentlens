// score.mjs — AgentLens 信任评分 + 定价基准引擎
//
// 输入: data/agents.ndjson
// 输出: data/index.json  (市场统计 + 每个 ASP 的信任分/定价分位 + 推荐)
//
// 用法: node agentlens/score.mjs

import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "agentlens", "data");
const AGENTS = path.join(DATA, "agents.ndjson");
const OUT = path.join(DATA, "index.json");

// ---------- 读取 ----------
const agents = fs
  .readFileSync(AGENTS, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// ---------- 工具 ----------
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// 价格口径：
//   priceInterval === "month"  → 订阅制，月度价 = price
//   priceInterval === null      → 按次计价（A2MCP / 单次交付），单价 = price
const MONTHLY = { month: 1, day: 30, week: 4.345, year: 1 / 12 };
function monthlyPrice(price, interval) {
  if (price == null) return null;
  if (interval == null) return null; // 按次，不计入月度价
  const f = MONTHLY[interval];
  if (f == null) return null;
  return price * f;
}
const isPerCall = (s) => s.price != null && s.price > 0 && s.priceInterval == null;
const isSubscription = (s) => s.price != null && s.price > 0 && s.priceInterval === "month";

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- 市场统计 ----------
const services = [];
for (const a of agents) {
  for (const s of a.services || []) {
    services.push({
      agentId: a.agentId,
      agentName: a.name,
      category: (a.categories || [])[0] || "OTHER",
      serviceId: s.serviceId,
      serviceName: s.name,
      price: s.price,
      priceInterval: s.priceInterval,
      perCall: isPerCall(s) ? s.price : null,
      monthly: monthlyPrice(s.price, s.priceInterval),
      salesCount: s.salesCount,
      freeTrial: s.freeTrial,
      serviceType: s.serviceType,
      symbol: s.symbol,
      agentScore: a.score,
      agentUsage: a.usageCount,
    });
  }
}

const byCategory = {};
for (const s of services) (byCategory[s.category] ||= []).push(s);

function bench(list) {
  const sorted = list.filter((x) => x != null && x > 0).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

const priceBench = {};
for (const [cat, list] of Object.entries(byCategory)) {
  priceBench[cat] = {
    services: list.length,
    perCall: bench(list.map((s) => s.perCall)),
    monthly: bench(list.map((s) => s.monthly)),
  };
}

const marketPriceBench = {
  perCall: bench(services.map((s) => s.perCall)),
  monthly: bench(services.map((s) => s.monthly)),
};

function verdict(v, b) {
  if (v == null || !b || b.median == null) return "unknown";
  if (v <= b.p25) return "cheap";
  if (v <= b.p75) return "fair";
  if (v <= b.p90) return "pricey";
  return "very_pricey";
}

// ---------- 信任评分 ----------
// 设计原则：小样本用贝叶斯收缩，向全市场均值靠拢；销量、好评率、在线、活跃度加权。
const C = 10; // 先验强度（等效于 10 条评价）
const globalMean = (() => {
  const rated = agents.filter((a) => num(a.score) != null);
  if (!rated.length) return 4.0;
  return rated.reduce((s, a) => s + a.score, 0) / rated.length;
})();

const maxUsage = Math.max(1, ...agents.map((a) => num(a.usageCount) || 0));
const now = Date.now();

function trustScore(a) {
  const score = num(a.score);
  const n = num(a.reviewSummary?.totalCount) ?? 0;
  // 1) 贝叶斯收缩评分（0-5）
  const shrunk = score == null ? globalMean : (C * globalMean + score * n) / (C + n);
  const ratingPart = clamp(shrunk / 5, 0, 1);

  // 2) 交付量（对数归一）
  const usage = num(a.usageCount) || 0;
  const deliveryPart = clamp(Math.log1p(usage) / Math.log1p(maxUsage), 0, 1);

  // 3) 好评率
  const ap = a.approvalRate ? parseFloat(String(a.approvalRate)) / 100 : null;
  const approvalPart = ap == null ? 0.5 : clamp(ap, 0, 1);

  // 4) 在线状态
  const onlinePart = a.onlineStatus === 1 ? 1 : 0;

  // 5) 新鲜度（最近 90 天内更新过 = 1）
  const updated = num(a.updatedAt);
  const freshPart = updated == null ? 0.5 : clamp(1 - (now - updated) / (90 * 864e5), 0, 1);

  const raw =
    0.34 * ratingPart + 0.26 * deliveryPart + 0.18 * approvalPart + 0.12 * onlinePart + 0.1 * freshPart;

  return {
    trust: Math.round(raw * 1000) / 10, // 0-100
    parts: {
      rating: Math.round(ratingPart * 1000) / 1000,
      delivery: Math.round(deliveryPart * 1000) / 1000,
      approval: Math.round(approvalPart * 1000) / 1000,
      online: onlinePart,
      freshness: Math.round(freshPart * 1000) / 1000,
    },
    shrunkRating: Math.round(shrunk * 100) / 100,
    reviewCount: n,
    confidence:
      n >= 20 ? "high" : n >= 5 ? "medium" : n >= 1 ? "low" : "none",
  };
}

const scored = agents
  .map((a) => {
    const t = trustScore(a);
    const cat = (a.categories || [])[0] || "OTHER";
    const perCalls = (a.services || []).filter(isPerCall).map((s) => s.price);
    const monthlies = (a.services || [])
      .map((s) => monthlyPrice(s.price, s.priceInterval))
      .filter((x) => x != null);
    const myPerCall = perCalls.length ? Math.min(...perCalls) : null;
    const myMonthly = monthlies.length ? Math.min(...monthlies) : null;
    const benchCat = priceBench[cat] || marketPriceBench;
    return {
      agentId: a.agentId,
      name: a.name,
      category: cat,
      score: num(a.score),
      approvalRate: a.approvalRate,
      usageCount: num(a.usageCount) || 0,
      onlineStatus: a.onlineStatus,
      serviceCount: a.serviceTotal || (a.services || []).length,
      lowestPerCallPrice: myPerCall,
      lowestMonthlyPrice: myMonthly,
      priceVerdictPerCall: verdict(myPerCall, benchCat.perCall),
      priceVerdictMonthly: verdict(myMonthly, benchCat.monthly),
      ownerAddress: a.ownerAddress,
      registryContract: a.registryContract,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      ...t,
    };
  })
  .sort((x, y) => y.trust - x.trust);

// ---------- 汇总 ----------
function hist(values, edges) {
  const out = edges.map((e) => ({ upTo: e, count: 0 }));
  for (const v of values) {
    let i = edges.findIndex((e) => v <= e);
    if (i < 0) i = edges.length - 1;
    out[i].count++;
  }
  return out;
}
const perCallValues = services.map((s) => s.perCall).filter((x) => x != null && x > 0);
const monthlyValues = services.map((s) => s.monthly).filter((x) => x != null && x > 0);
const deliveryValues = agents.map((a) => num(a.usageCount) || 0);
const BIG = 1e12;

const summary = {
  generatedAt: new Date().toISOString(),
  agentCount: agents.length,
  serviceCount: services.length,
  perCallServiceCount: services.filter((s) => s.perCall != null).length,
  subscriptionServiceCount: services.filter((s) => s.monthly != null).length,
  freeServiceCount: services.filter((s) => !s.price).length,
  totalDeliveries: agents.reduce((s, a) => s + (num(a.usageCount) || 0), 0),
  onlineAgents: agents.filter((a) => a.onlineStatus === 1).length,
  agentsWithReviews: agents.filter((a) => (a.reviewSummary?.totalCount || 0) > 0).length,
  agentsWithZeroDeliveries: agents.filter((a) => !(num(a.usageCount) > 0)).length,
  totalReviews: agents.reduce((s, a) => s + (num(a.reviewSummary?.totalCount) || 0), 0),
  categoryCount: Object.keys(byCategory).length,
  categories: Object.fromEntries(
    Object.entries(byCategory)
      .map(([k, v]) => [
        k,
        {
          agents: new Set(v.map((s) => s.agentId)).size,
          services: v.length,
          deliveries: [...new Set(v.map((s) => s.agentId))].reduce(
            (s, id) => s + (num(agents.find((a) => a.agentId === id)?.usageCount) || 0),
            0
          ),
        },
      ])
      .sort((a, b) => b[1].services - a[1].services)
  ),
  marketPriceBench,
  priceBenchByCategory: priceBench,
  histograms: {
    perCall: hist(perCallValues, [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 100, 1000, BIG]),
    monthly: hist(monthlyValues, [1, 3, 5, 10, 20, 50, 100, 500, BIG]),
    deliveries: hist(deliveryValues, [0, 1, 5, 10, 50, 100, 500, 1000, 10000, BIG]),
  },
  globalMeanRating: Math.round(globalMean * 100) / 100,
  trustTop20: scored.slice(0, 20).map((s) => ({
    agentId: s.agentId,
    name: s.name,
    trust: s.trust,
    score: s.score,
    reviews: s.reviewCount,
    deliveries: s.usageCount,
    category: s.category,
  })),
};

fs.writeFileSync(OUT, JSON.stringify({ summary, agents: scored }, null, 1));
console.log("=== AgentLens 市场概览 ===");
console.log(`Agent 总数:        ${summary.agentCount} (在线 ${summary.onlineAgents})`);
console.log(
  `服务总数:          ${summary.serviceCount} (按次 ${summary.perCallServiceCount} / 订阅 ${summary.subscriptionServiceCount} / 免费 ${summary.freeServiceCount})`
);
console.log(`累计交付量:        ${summary.totalDeliveries}`);
console.log(`评价总数:          ${summary.totalReviews} (有评价的 Agent ${summary.agentsWithReviews})`);
console.log(`零交付 Agent:      ${summary.agentsWithZeroDeliveries} / ${summary.agentCount}`);
const pb = marketPriceBench.perCall;
const mb = marketPriceBench.monthly;
console.log(
  `按次价中位数:      ${pb.median?.toFixed(4)} USDT  (p10 ${pb.p10?.toFixed(4)} / p25 ${pb.p25?.toFixed(4)} / p75 ${pb.p75?.toFixed(4)} / max ${pb.max?.toFixed(2)}, n=${pb.n})`
);
console.log(
  `订阅价中位数:      ${mb.median?.toFixed(2)} USDT/月  (p25 ${mb.p25?.toFixed(2)} / p75 ${mb.p75?.toFixed(2)} / max ${mb.max?.toFixed(2)}, n=${mb.n})`
);
console.log(`\n品类分布:`);
for (const [k, v] of Object.entries(summary.categories))
  console.log(
    `  ${k.padEnd(18)} agents=${String(v.agents).padStart(4)} services=${String(v.services).padStart(4)} deliveries=${v.deliveries}`
  );
console.log(`\n信任分 Top 10:`);
for (const t of summary.trustTop20.slice(0, 10))
  console.log(
    `  ${String(t.trust).padStart(5)}  ${String(t.name).slice(0, 26).padEnd(28)} 评分${t.score ?? "-"} 评价${t.reviews} 交付${t.deliveries}`
  );
console.log(`\n→ ${OUT}`);
