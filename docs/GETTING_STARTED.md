# Getting Started

This guide gets the local read-only board running from a fresh checkout.

## Requirements

- Node.js compatible with the repo lockfile.
- `npm install` completed.
- Optional API keys in `.env` for richer data and AI calls.

## Setup

```bash
npm install
cp .env.example .env
npm run bootstrap
```

`bootstrap` initializes SQLite, imports fixtures, and runs the first market
snapshot. If `ODDS_API_KEY` is empty, the app can still run in a reduced
Polymarket/Kalshi-oriented mode.

## Local Board

```bash
npm run board
```

The server binds to `127.0.0.1:4626` by default. If that port is occupied and no
explicit `BOARD_PORT` or `PORT` is set, it tries `4627-4636`.

Primary routes:

- `/`: landing page for users and judges.
- `/radar`: live market radar.
- `/alerts`: recent alert log, 24h count, ServerChan status, and push cap.
- `/opportunities`: ranked opportunity board.
- `/walrus`: Walrus manifest, artifacts, snapshots, and publish logs.
- `/review`: post-match odds replay.
- `/match?fk=<fixture_key>`: match detail page.

When a score has been matched into `match_result`, match cards show it directly:
the winning side is green, the losing side is red, and draws use a neutral
amber treatment. Unplayed or unmatched fixtures do not show fake `0-0`
scorelines. In 1X2 probability groups, the highest probability is highlighted;
that highlight is predictive only and is visually separate from the result
colors.

Use `?lang=zh` for Chinese or `?lang=en` for English. English is the default.

## Core Commands

```bash
npm run status
npm run health
npm run current -- --limit=8
npm run avoid:sporttery -- --limit=20 --threshold=2
npm run results
npm run poll
npm run daemon
```

`npm run results` performs one score/result collection pass. It uses
API-Football first when `API_FOOTBALL_KEY` is configured; otherwise it tries
Sporttery public scores and then The Odds API scores when `ODDS_API_KEY` is
available. Score-only fallbacks can fill `match_result`, but they do not provide
goal timelines.

Sporttery commands are intentionally manual/low-frequency:

```bash
npm run fetch:sporttery
npm run import:sporttery -- data/imports/sporttery.csv
```

Walrus commands:

```bash
npm run export:walrus
npm run publish:walrus:testnet
npm run publish:walrus:testnet:compact
```

## AI Provider Fallback

AI analysis supports Anthropic, DeepSeek, Kimi/Moonshot, and generic
OpenAI-compatible chat completions. If no provider key is configured, the board
shows a prompt preview and copy workflow instead of failing the page.

Provider variables are documented in `.env.example`. The betting-plan dialog can
also accept temporary provider settings for a single request; those values are
not persisted.

## Public Repo Hygiene

Before publishing source, confirm generated/runtime state remains ignored:

```bash
git check-ignore -v data/wc26.db data/walrus-feed/manifest-latest.json .env logs/daemon.log
```

Never commit `.env`, SQLite databases, logs, `data/imports/`, or
`data/walrus-feed/`.
