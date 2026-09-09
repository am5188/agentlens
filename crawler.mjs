// crawler.mjs — OKX.AI Agent 广场索引器
//
// 数据源：
//   1) https://www.okx.ai/sitemap/agents/{1..N}   → 全部 Agent ID
//   2) https://www.okx.ai/zh-hans/agents/{id}     → 内嵌 JSON (__app_data_for_ssr__)
//
// 输出: data/agents.ndjson (每行一个 Agent 的完整快照)
//
// 用法:
//   node agentlens/crawler.mjs probe            探测单个页面的 JSON 结构
//   node agentlens/crawler.mjs ids              只收集 Agent ID 清单
//   node agentlens/crawler.mjs crawl [--limit N] 全量抓取

import fs from "node:fs";
import path from "node:path";

const BASE = "https://www.okx.ai";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const OUT_DIR = path.join(process.cwd(), "agentlens", "data");
const AGENTS_NDJSON = path.join(OUT_DIR, "agents.ndjson");
const IDS_JSON = path.join(OUT_DIR, "agent-ids.json");
const MAX_SITEMAP_PAGES = 40;
const CONCURRENCY = 2;

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries) throw e;
      await sleep(800 * i);
    }
  }
}

function extractAppState(html) {
  const m = html.match(
    /<script[^>]*data-id="__app_data_for_ssr__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return { __parseError: String(e) };
  }
}

function findAgentDetail(obj) {
  // 递归找到含 agentId 的 overview 对象
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (cur.overview && cur.overview.agentId) return cur;
    for (const k of Object.keys(cur)) stack.push(cur[k]);
  }
  return null;
}

function normalize(detail, agentId) {
  const o = detail.overview || {};
  const svcList = (detail.services && detail.services.list) || [];
  const reviewBlock = detail.review || detail.reviews || detail.evaluation || null;
  return {
    agentId: String(o.agentId || agentId),
    name: o.name || null,
    onlineStatus: o.onlineStatus ?? null,
    score: o.score != null ? Number(o.score) : null,
    approvalRate: o.approvalRate || null,
    usageCount: o.usageCount != null ? Number(o.usageCount) : null,
    network: o.network || null,
    chainIndex: o.chainIndex ?? null,
    ownerAddress: o.ownerAddress || null,
    registryContract: o.registryContract || null,
    registryTx: o.registryTx || null,
    createdAt: o.createdAt ?? null,
    updatedAt: o.updatedAt ?? null,
    categories: o.categories || [],
    serviceLowestFee: o.serviceLowestFee != null ? Number(o.serviceLowestFee) : null,
    description: o.description || null,
    services: svcList.map((s) => ({
      serviceId: s.serviceId ?? null,
      name: s.name ?? null,
      price: s.price != null ? Number(s.price) : null,
      priceInterval: s.priceInterval || null,
      serviceType: s.serviceType || null,
      symbol: s.symbol || null,
      freeTrial: s.freeTrial != null ? Number(s.freeTrial) : null,
      subscriptionType: s.subscriptionType ?? null,
      salesCount: s.salesCount != null ? Number(s.salesCount) : null,
      descLen: (s.description || "").length,
    })),
    serviceTotal: (detail.services && detail.services.total) ?? svcList.length,
    reviewSummary: reviewBlock
      ? {
          totalScore: reviewBlock.totalScore != null ? Number(reviewBlock.totalScore) : null,
          totalCount: reviewBlock.totalCount != null ? Number(reviewBlock.totalCount) : null,
          distribution: reviewBlock.distribution || null,
        }
      : null,
    reviews: reviewBlock && Array.isArray(reviewBlock.list)
      ? reviewBlock.list.slice(0, 20).map((r) => ({
          rating: r.rating ?? r.score ?? null,
          time: r.createdAt ?? r.time ?? null,
          textLen: (r.content || r.text || "").length,
        }))
      : null,
    reviewKeys: reviewBlock ? Object.keys(reviewBlock) : null,
    allKeys: Object.keys(detail),
    crawledAt: Date.now(),
  };
}

async function collectIds() {
  const ids = new Set();
  for (let p = 1; p <= MAX_SITEMAP_PAGES; p++) {
    let html;
    try {
      html = await fetchText(`${BASE}/sitemap/agents/${p}`);
    } catch (e) {
      console.log(`sitemap ${p}: ${e.message}`);
      break;
    }
    const before = ids.size;
    for (const m of html.matchAll(/href="\/(?:zh-hans\/)?agents\/(\d+)"/g)) ids.add(m[1]);
    console.log(`sitemap ${p}: +${ids.size - before} (total ${ids.size})`);
    if (ids.size === before) break;
    await sleep(300);
  }
  const arr = [...ids].sort((a, b) => Number(a) - Number(b));
  fs.writeFileSync(IDS_JSON, JSON.stringify(arr, null, 1));
  console.log(`共收集 ${arr.length} 个 Agent ID → ${IDS_JSON}`);
  return arr;
}

async function crawl(limit) {
  let ids;
  if (fs.existsSync(IDS_JSON)) ids = JSON.parse(fs.readFileSync(IDS_JSON, "utf8"));
  else ids = await collectIds();

  // 断点续抓：跳过已成功写入的 ID，追加写入
  const doneIds = new Set();
  if (fs.existsSync(AGENTS_NDJSON)) {
    for (const l of fs.readFileSync(AGENTS_NDJSON, "utf8").split("\n").filter(Boolean)) {
      try {
        doneIds.add(String(JSON.parse(l).agentId));
      } catch {}
    }
  }
  let todo = ids.filter((id) => !doneIds.has(String(id)));
  console.log(`已完成 ${doneIds.size}，待抓取 ${todo.length}`);
  if (limit) todo = todo.slice(0, limit);

  const out = fs.createWriteStream(AGENTS_NDJSON, { flags: "a" });
  let done = 0;
  let failed = 0;
  let idx = 0;

  async function worker() {
    while (idx < todo.length) {
      const id = todo[idx++];
      try {
        const html = await fetchText(`${BASE}/zh-hans/agents/${id}`);
        const state = extractAppState(html);
        const detail = state ? findAgentDetail(state) : null;
        if (!detail) throw new Error("no appState/AgentDetail");
        out.write(JSON.stringify(normalize(detail, id)) + "\n");
      } catch (e) {
        failed++;
        console.log(`  agent ${id} FAILED: ${e.message}`);
      }
      done++;
      if (done % 25 === 0) console.log(`进度 ${done}/${todo.length} (失败 ${failed})`);
      await sleep(400);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.end();
  console.log(`\n完成: ${done} 抓取, ${failed} 失败 → ${AGENTS_NDJSON}`);
}

const cmd = process.argv[2] || "crawl";
if (cmd === "probe") {
  const id = process.argv[3] || "8136";
  const html = await fetchText(`${BASE}/zh-hans/agents/${id}`);
  const state = extractAppState(html);
  if (!state) {
    console.log("未找到 __app_data_for_ssr__");
    process.exit(1);
  }
  const detail = findAgentDetail(state);
  console.log("AgentDetail keys:", detail ? Object.keys(detail) : null);
  if (detail) {
    console.log("\noverview:", JSON.stringify(detail.overview, null, 1).slice(0, 2000));
    console.log("\nservices:", JSON.stringify(detail.services, null, 1).slice(0, 1500));
    for (const k of Object.keys(detail)) {
      if (k === "overview" || k === "services") continue;
      console.log(`\n${k}:`, JSON.stringify(detail[k], null, 1).slice(0, 1200));
    }
  }
} else if (cmd === "ids") {
  await collectIds();
} else if (cmd === "crawl") {
  const li = process.argv.indexOf("--limit");
  await crawl(li > 0 ? Number(process.argv[li + 1]) : 0);
} else {
  console.log("用法: probe [id] | ids | crawl [--limit N]");
}
