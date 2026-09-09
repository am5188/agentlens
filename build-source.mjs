// build-source.mjs — 生成源码浏览页 + 源码压缩包（供 Worker 提供 /source 与 /source.tar.gz）
//
// 产出:
//   agentlens/worker/source-html.js   —— 导出一段 HTML（文件树 + 每个文件的内容）
//   agentlens/worker/source-tar.js    —— 导出 base64 的 tar.gz（可下载）
//
// 用法: node agentlens/build-source.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = process.cwd();
const W = path.join(ROOT, "agentlens", "worker");

const FILES = [
  ["agentlens/README.md", "README.md"],
  ["agentlens/crawler.mjs", "crawler.mjs"],
  ["agentlens/score.mjs", "score.mjs"],
  ["agentlens/server.mjs", "server.mjs"],
  ["agentlens/mcp.mjs", "mcp.mjs"],
  ["agentlens/build-worker.mjs", "build-worker.mjs"],
  ["agentlens/build-source.mjs", "build-source.mjs"],
  ["agentlens/test-x402.mjs", "test-x402.mjs"],
  ["agentlens/refresh.ps1", "refresh.ps1"],
  ["agentlens/public/index.html", "public/index.html"],
  ["agentlens/worker/index.js", "worker/index.js"],
  ["agentlens/worker/wrangler.toml", "worker/wrangler.toml"],
  [".tools/okx-asp/okx-asp.mjs", "tools/okx-asp.mjs"],
  [".tools/okx-asp/listing.json", "tools/listing-a2mcp.json"],
  [".tools/okx-asp/listing-a2a.json", "tools/listing-a2a.json"],
];

const esc = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const entries = [];
for (const [rel, shown] of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const content = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  entries.push({ path: shown, content, lines: content.split("\n").length });
}

console.log("打包文件:");
let totalBytes = 0;
for (const e of entries) {
  totalBytes += Buffer.byteLength(e.content);
  console.log(`  ${e.path.padEnd(28)} ${String(e.lines).padStart(5)} 行`);
}
console.log(`共 ${entries.length} 个文件, ${(totalBytes / 1024).toFixed(1)} KB`);

// ---------- 源码浏览页 ----------
const nav = entries
  .map((e) => `<a href="#${encodeURIComponent(e.path)}">${esc(e.path)}</a>`)
  .join("\n      ");
const body = entries
  .map(
    (e) => `<section id="${encodeURIComponent(e.path)}">
  <h3>${esc(e.path)} <span class="m">${e.lines} 行</span></h3>
  <pre>${esc(e.content)}</pre>
</section>`
  )
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentLens — Source</title>
<style>
  :root{--bg:#07090d;--panel:#0e131b;--line:#1e2733;--fg:#e8eef6;--dim:#8b9bb0;--accent:#4ee1a0}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:26px;margin:0 0 6px} h1 span{color:var(--accent)}
  p.tag{color:var(--dim);margin:0 0 20px}
  .nav{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 26px}
  .nav a{font:12px ui-monospace,Consolas,monospace;color:var(--fg);text-decoration:none;
    background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:5px 9px}
  .nav a:hover{border-color:var(--accent);color:var(--accent)}
  section{margin:0 0 26px}
  h3{font:13px ui-monospace,Consolas,monospace;color:var(--accent);margin:0 0 8px;
     border-bottom:1px solid var(--line);padding-bottom:6px}
  h3 .m{color:var(--dim);font-weight:400}
  pre{background:#0a0f16;border:1px solid var(--line);border-radius:11px;padding:14px;
      overflow:auto;font:12px/1.55 ui-monospace,Consolas,monospace;color:#cfe0f2;max-height:520px}
  .dl{display:inline-block;margin-right:10px;font:12px ui-monospace,monospace;color:var(--accent);
      border:1px solid #1d4a3a;background:#0c1a16;border-radius:7px;padding:6px 11px;text-decoration:none}
  footer{color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding-top:16px;margin-top:30px}
</style></head>
<body><div class="wrap">
  <h1>Agent<span>Lens</span> — Source</h1>
  <p class="tag">Complete source of the AgentLens trust &amp; price oracle: indexer, scoring engine, x402 API, MCP server, Cloudflare Worker, and the OKX.AI ASP registration tooling.</p>
  <div>
    <a class="dl" href="/source.tar.gz">↓ 下载 source.tar.gz</a>
    <a class="dl" href="/">← 回到看板</a>
    <a class="dl" href="/market">API /market</a>
  </div>
  <div class="nav">${nav}</div>
  ${body}
  <footer>${entries.length} files · ${(totalBytes / 1024).toFixed(1)} KB · generated ${new Date().toISOString()}</footer>
</div></body></html>`;

fs.writeFileSync(path.join(W, "source-html.js"), "export default " + JSON.stringify(html) + ";\n");
console.log("→ worker/source-html.js", (fs.statSync(path.join(W, "source-html.js")).size / 1024).toFixed(0) + " KB");

// ---------- tar.gz ----------
function tarHeader(name, size) {
  const b = Buffer.alloc(512);
  b.write(name.slice(0, 99), 0, "utf8");
  b.write("0000644\0", 100, "utf8"); // mode
  b.write("0000000\0", 108, "utf8"); // uid
  b.write("0000000\0", 116, "utf8"); // gid
  b.write(size.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  b.write("00000000000\0", 136, "utf8"); // mtime
  b.write("        ", 148, "utf8"); // checksum placeholder
  b.write("0", 156, "utf8"); // typeflag
  b.write("ustar\0", 257, "utf8");
  b.write("00", 263, "utf8");
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  return b;
}
const chunks = [];
for (const e of entries) {
  const data = Buffer.from(e.content, "utf8");
  chunks.push(tarHeader("agentlens/" + e.path, data.length));
  chunks.push(data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) chunks.push(Buffer.alloc(pad));
}
chunks.push(Buffer.alloc(1024)); // end of archive
const tar = Buffer.concat(chunks);
const gz = zlib.gzipSync(tar, { level: 9 });
fs.writeFileSync(path.join(W, "source-tar.js"), "export default " + JSON.stringify(gz.toString("base64")) + ";\n");
console.log(`→ worker/source-tar.js ${(gz.length / 1024).toFixed(0)} KB (tar ${(tar.length / 1024).toFixed(0)} KB)`);
