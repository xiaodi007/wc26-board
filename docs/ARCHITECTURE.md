# Architecture

WC Radar is a TypeScript local read-only app. It combines CLI collectors,
SQLite storage, query modules, and a server-rendered board.

## Storage Model

The core schema follows a small append-friendly model:

- `event`: source events and canonical fixture identity.
- `market`: market metadata such as platform, market type, and close time.
- `outcome`: outcome labels and source-specific identifiers.
- `snapshot`: append-only price/probability observations.
- `meta`: lightweight runtime metadata such as API quota, Walrus publish state,
  and prompt templates.

Additional tables support alerts, AI analyses, match results, match events, and
Walrus publish logs.

## Fixture Merge

Different sources may report the same match with slightly different kickoff
times or team names. The write path normalizes teams, applies aliases, and uses
`fixture_key` to merge same-team same-day matches when kickoff times are within
the accepted tolerance. The health check flags future approximate splits.

The goal is one canonical match card for cases such as `USA vs Paraguay`, even
when sources differ by a few minutes.

## Data Flow

Collectors write source data into SQLite. Read-layer query modules normalize and
combine that data for:

- current 1X2 probabilities;
- market intelligence and opportunity scoring;
- line history and post-match review windows;
- Sporttery avoid/value comparisons;
- offered-odds extraction for betting simulations;
- Walrus aggregate feed exports.

Devig and probability blending happen in read/query modules rather than
overwriting raw source observations.

## Board Rendering

`src/server.ts` serves HTML and JSON from `127.0.0.1` only. UI pages are
server-rendered in `src/board/render.ts` with shared i18n copy from
`src/board/i18n.ts`.

Matched scorelines are read from `match_result` through
`getMatchEventBundle(fixture_key)` during page rendering. The renderer uses a
request-local fixture cache so one page render does not repeat the same result
lookup while still picking up daemon-written score updates on the next request.
Result colors are semantic: winner green, loser red, draw neutral/amber. The
highest probability in each 1X2 group uses a separate predictive highlight.

Important routes:

- `/`: landing page.
- `/radar`: live dashboard.
- `/alerts`: alert log and push-status page.
- `/opportunities`: full opportunity ranking.
- `/review`: post-match odds replay.
- `/walrus`: public data snapshot page.
- `/match`: match detail page.
- `/api/*`: JSON read endpoints.

Important read endpoints:

- `/api/match-events?fk=<fixture_key>` returns the preferred scoreline, any
  matched events, all raw result rows, and source status metadata for
  API-Football, Sporttery scores, and The Odds API scores.
- `/api/probability` defaults to a compact ranked candidate list. Use
  `?fk=<fixture_key>`, `?detail=full`, or `?compact=0` when a caller needs the
  full source-contribution detail.

The only intentional board-side writes are AI analysis history and prompt
template updates. Betting simulation inputs such as bankroll, stake, and
temporary API keys are not persisted.

## Runtime Processes

- `npm run poll`: one manual market collection pass.
- `npm run results`: one manual score/result collection pass.
- `npm run daemon`: continuous collection, alerts, result polling, and optional
  compact Walrus publishing.
- `npm run board`: local HTTP board.
- `npm run health`: data integrity and freshness checks.
