# WC Radar

AI-assisted 2026 World Cup market intelligence for Overflow judges, football
fans, and disciplined odds researchers.

WC Radar aggregates match fixtures, bookmaker odds, prediction-market liquidity,
Sporttery prices, line movement, post-match evidence, and Walrus snapshots into
one local read-only board. It helps users compare prices, spot market
disagreement, avoid obviously poor odds, and keep risk controls visible before
acting elsewhere.

中文简述:这是一个 2026 世界杯赔率与预测市场聚合雷达，强调 Walrus 可验证数据层、AI 辅助分析、赛后复盘和风险纪律；不执行下注、不托管资金、不承诺收益。

## Live Demo / 在线预览

Public demo: **https://crossing-tide-extra-explicit.trycloudflare.com**

Quick links (add `?lang=en` for English):

- [Landing page](https://crossing-tide-extra-explicit.trycloudflare.com/)
- [Live radar](https://crossing-tide-extra-explicit.trycloudflare.com/radar?lang=zh)
- [Walrus snapshots](https://crossing-tide-extra-explicit.trycloudflare.com/walrus?lang=zh)
- [Post-match review](https://crossing-tide-extra-explicit.trycloudflare.com/review?lang=zh)
- [Opportunities](https://crossing-tide-extra-explicit.trycloudflare.com/opportunities?lang=zh)
- [Alerts](https://crossing-tide-extra-explicit.trycloudflare.com/alerts?lang=zh)

> This is a temporary Cloudflare quick tunnel for demos, not stable production
> infrastructure: if the tunnel container is recreated, the URL can change. If the
> link is down, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for how to fetch the
> current URL.
>
> 中文:以上为临时演示地址(Cloudflare 隧道),可能会变动;失效时见部署文档获取最新地址。

## What Judges Should See First

- Landing page at `/`: product narrative, live metrics, current match radar, and
  direct demo path.
- Live radar at `/radar`: upcoming and live World Cup matches, multi-source
  odds, market disagreement, Sporttery avoid/value signals, alerts, and data
  health. Match cards show final scores when a result has been matched.
- Alerts at `/alerts`: recent price jumps, Sporttery edge/avoid alerts, health
  alerts, 24h alert count, ServerChan status, and the daily push cap.
- Opportunities at `/opportunities`: ranked market opportunities with liquidity,
  probability gaps, risk tags, and model transparency.
- Walrus page at `/walrus`: sanitized public snapshots, manifest metadata,
  artifact hashes, aggregator links, Walruscan links, and public AI digest.
- Review page at `/review`: post-match odds replay from 24 hours before kickoff
  through the live window, with scorelines and event context when available.
  Winners are marked green, losers red, and draws neutral/amber.

See [Live Demo](#live-demo--在线预览) above for the public URL, and
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full deployment runbook.

## Why It Matters

World Cup markets are fragmented. Users often need to compare traditional books,
prediction markets, local Sporttery prices, and live market movement manually.
WC Radar puts those signals into one workflow:

- Aggregates Polymarket, Kalshi, The Odds API, Pinnacle-derived consensus,
  Sporttery HAD/HHAD, match results, and optional goal events.
- Normalizes each match into a canonical fixture so slightly different source
  kickoff times do not split the same game.
- Highlights disagreement between platforms, market freshness, liquidity depth,
  active-trader signals, and top-holder concentration.
- Highlights the highest 1X2 probability in each probability group without
  using loser-red styling for prediction-only information.
- Adds AI match analysis and bankroll-aware betting-plan simulation without
  storing user API keys, bankroll, or stake amounts.
- Publishes only sanitized aggregate snapshots to Walrus, not raw databases,
  credentials, wallets, private configuration, or user bankroll data.

## Walrus / Overflow Story

WC Radar uses Walrus as the public, verifiable data layer for a sports market
intelligence app:

- `npm run export:walrus` writes aggregate-only JSON snapshots.
- `npm run publish:walrus:testnet` or `npm run publish:walrus:testnet:compact`
  publishes a manifest and artifacts through a Walrus publisher.
- The board displays manifest blob ids, schema, artifact hashes, publish logs,
  aggregator JSON links, and Walruscan links.
- Public snapshots include market metrics, risk signals, source freshness,
  opportunity rankings, and public AI summaries.

The positioning is: AI-assisted sports market intelligence plus verifiable
off-chain data snapshots.

## AI Betting Assistance

The AI flow is decision support, not automated betting:

- Users can generate a board-level or match-level betting simulation.
- Temporary provider settings and API keys are accepted in the browser dialog
  for one request only and are not written to `.env`, SQLite, logs, or Walrus.
- The model estimates probabilities, reasoning, risks, and cancellation
  conditions.
- Local code calculates stake sizing with a 25% Kelly fraction, a 1% bankroll
  single-bet cap, offered odds, expected value, potential net profit, and maximum
  loss.
- The no-key fallback still exposes a transparent prompt for manual review.

This project does not place bets, route orders, custody funds, guarantee profit,
or guarantee a higher win rate.

## Quick Start

```bash
npm install
cp .env.example .env
npm run bootstrap
npm run status
npm run health
npm run board
```

The board binds to `127.0.0.1:4626` by default and automatically tries
`4627-4636` if the default port is occupied.

Useful commands:

```bash
npm run current -- --limit=8
npm run avoid:sporttery -- --limit=20 --threshold=2
npm run results
npm run fetch:sporttery
npm run import:sporttery -- data/imports/sporttery.csv
npm run export:walrus
npm run publish:walrus:testnet:compact
```

## Documentation

- [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md): local setup, commands,
  board startup, and provider-key fallback.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): schema, data flow, fixture
  merge, polling/read layer, and server-rendered board.
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md): Polymarket, Kalshi, The Odds
  API, Sporttery, score/event fallbacks, freshness, and compliance boundaries.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): VPS/Docker/Cloudflare tunnel
  runbook and post-deploy smoke checks.
- [`docs/WALRUS.md`](docs/WALRUS.md): sanitized feed, manifest/artifacts,
  publish/read flow, and Overflow narrative.
- [`docs/AI_BETTING_PLAN.md`](docs/AI_BETTING_PLAN.md): AI providers, temporary
  keys, Kelly simulation, offered odds, and risk controls.
- [`docs/REVIEW_CHECKLIST.md`](docs/REVIEW_CHECKLIST.md): pre-commit and public
  repo checks.

## Safety Boundary

This is a local read-only research and demo app. The public repository should
contain source code and documentation only. Do not commit `.env`, SQLite
databases, logs, raw imports, or generated Walrus feed files.

Sporttery ingestion is low-frequency/manual and uses public calculator data or
local imports. The project does not log in, bypass CAPTCHA/signatures, use proxy
pools, or run high-frequency automated Sporttery scraping.
