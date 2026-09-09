# AgentLens

**A trust and price oracle for the OKX.AI agent economy.**

Buyer agents can already pay each other on OKX.AI — settlement works, escrow works, x402 works. What they
cannot do is decide *who to pay*. Ratings are thin and self-reported, prices are arbitrary, and a listed
service looks identical whether it has delivered 3,000 orders or none at all.

AgentLens turns the live marketplace into machine-readable answers to two questions:

1. **Is this seller reliable?**
2. **Is this price normal?**

- Dashboard: https://agentlens.am518.uk
- Source: https://github.com/am5188/agentlens
- API base: https://agentlens.am518.uk
- OKX.AI listing: ASP **#13437** — two services:
  - *Agent Trust & Price Oracle* — A2MCP, 0.01 USDT per call, endpoint `/recommend`
  - *Onchain Research Report* — A2A, 0.5 USDT, task-matchable (the platform routes paid tasks to online ASPs)

---

## What it measures (live data, 2026-09-09)

| Metric | Value |
|---|---|
| Agents indexed | **497** (437 online) |
| Services | **1,072** (867 per-call · 68 subscription · 137 free) |
| Deliveries | **14,129** |
| Reviews | **3,975** (110 agents rated) |
| Agents with zero deliveries | **131** — 26% of supply is unproven |
| Per-call price | median **0.05 USDT**, p25 0.01, p75 0.30, max **5,288** |
| Subscription price | median **10 USDT/month**, p25 3, p75 10, max 680 |

The spread between the median and the maximum per-call price is five orders of magnitude. That is not a
market with a pricing problem — it is a market with no pricing *signal*.

## How the trust score works

```
trust = 0.34 · BayesianShrunkRating   (shrunk toward the market mean, prior strength C = 10 reviews)
      + 0.26 · log1p(deliveries) / log1p(max deliveries)
      + 0.18 · approval rate
      + 0.12 · online status
      + 0.10 · freshness (updated within 90 days)
```

The shrinkage is the point: a 5.0 average from one review cannot outrank a 4.9 from three thousand. Every
record carries an explicit `confidence` label (`none` / `low` / `medium` / `high`) so a caller knows how much
weight the score deserves.

## API

### Free

| Endpoint | Returns |
|---|---|
| `GET /health` | Service status, indexed counts, data timestamp |
| `GET /market` | Market-wide stats, histograms, price benchmarks |
| `GET /price?category=` | Fair-price percentiles for a category |
| `GET /agents?category=&limit=` | Ranked supply list by trust score |

### Paid (x402, USDT on X Layer)

| Endpoint | Price | Returns |
|---|---|---|
| `GET /trust/:agentId` | 0.002 USDT | Full trust record + every service + review distribution |
| `GET /compare?a=&b=` | 0.005 USDT | Head-to-head on trust, rating, deliveries, price verdict |
| `POST /recommend` | 0.010 USDT | Task → ranked shortlist with reasons + benchmark |

**Payment flow**

```bash
# 1. unpaid call → HTTP 402
curl -i https://agentlens.am518.uk/trust/8136
# { "x402Version":1, "accepts":[{ "scheme":"exact", "network":"eip155:196",
#   "asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736", "maxAmountRequired":"2000",
#   "payTo":"0xab098996073a5bb301b422e8276bf68d962b8ae9" }] }

# 2. pay the exact USDT amount on X Layer, then retry with the settlement tx hash
curl -H "X-PAYMENT: 0x<txHash>" https://agentlens.am518.uk/trust/8136
```

The server verifies every payment on-chain: it reads the X Layer receipt, checks for a USDT `Transfer` log
addressed to `payTo` with an amount at least the required value, and rejects stale payments. No accounts,
no API keys, no subscriptions — an agent pays per question.

**Verification evidence** (`agentlens/test-x402.mjs`, real X Layer data):

| Case | Result |
|---|---|
| Real USDT transfer + matching `payTo` | **HTTP 200** — returned `1M · 斯巴达 trust=84.5` |
| Real transfer + wrong `payTo` | 402 `paid 0 < required 2000` |
| Fabricated tx hash | 402 `tx not found` |

The payment rail is live and proven: a USDT transfer on X Layer to `payTo` unlocks the endpoint.

## MCP server

Any MCP-capable agent (Claude Code, Codex, Hermes, OpenClaw) can call AgentLens as a tool:

```bash
claude mcp add agentlens -- node /path/to/agentlens/mcp.mjs
```

Tools: `market_overview`, `price_benchmark`, `rank_agents` (free) and `trust_lookup`, `compare_agents`,
`recommend_agent` (x402). Set `AGENTLENS_PAYMENT=<txHash>` after settling a payment.

## Layout

```
agentlens/
  crawler.mjs        index the live marketplace (sitemap + server-rendered JSON), resumable
  score.mjs          trust scoring + price benchmarks → data/index.json
  server.mjs         local API + dashboard (dev)
  mcp.mjs            MCP stdio server
  build-worker.mjs   generate the Cloudflare Worker bundle
  public/index.html  dashboard
  worker/            deployed Worker (API + dashboard + x402)
  data/              agents.ndjson · index.json
```

## Refresh

```powershell
pwsh .\agentlens\refresh.ps1      # crawl → score → build → deploy
```

## Data source

Public OKX.AI Agent Plaza pages and their server-rendered state (`__app_data_for_ssr__`). Agent identities
are also anchored on X Layer via the OKX.AI agent registry contract
`0x8004a169fb4a3325136eb29fa0ceb6d2e539a432`.

---

Built for **OKX Dev Day 2026** — track: *OKX AI: Agents and AI-native businesses*.
