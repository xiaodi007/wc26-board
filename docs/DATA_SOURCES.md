# Data Sources

WC Radar combines public or user-keyed football market sources into one local
read-only database.

## Source Matrix

| Source | Auth | Default cadence | Data |
| --- | --- | --- | --- |
| Polymarket Gamma | none | 5 min | World Cup outrights and match-winner markets |
| Polymarket Data API | none | collector-batched | holder depth, trades, active-trader signals |
| Kalshi public markets | none | 5 min | World Cup outrights and match series |
| The Odds API | API key | about 90 min on free tier | bookmaker 1X2 odds and score fallback |
| Sporttery | public calculator/manual import | manual or low-frequency | HAD and HHAD prices |
| API-Football | optional API key | about 10 min | scorelines and goal events |

## Polymarket

The collector uses strict World Cup match filters to avoid props, halftime,
exact-score, and other derivative markets polluting the main event table.
Gamma market fields provide liquidity, volume, spread, and last-trade price.
Data API holder/trade endpoints enrich top-holder depth and 24h active traders.

Participant metrics are shown as sampled market intelligence, not as a claim of
total market participants.

## Kalshi

Kalshi public markets are used for World Cup outrights and match-level series.
The app maps each match market back onto canonical fixtures by team and match
day instead of creating isolated events when precise kickoff metadata is absent.

## The Odds API And Book Consensus

The Odds API provides bookmaker 1X2 prices when `ODDS_API_KEY` is configured.
The app tracks quota metadata in `meta` and uses a conservative polling interval
for the free tier.

Book consensus uses a median-style read layer to reduce the impact of stale or
outlier books.

## Sporttery

Sporttery ingestion is deliberately conservative:

- low-frequency/manual fetches from public calculator data;
- local CSV/JSON import fallback;
- no login;
- no CAPTCHA/signature bypass;
- no proxy pools;
- no high-frequency daemon scraping.

HAD feeds Sporttery 1X2 comparison. HHAD is displayed as a handicap-price panel
and is not treated as the same market as standard 1X2.

## Scores And Events

API-Football can provide scorelines and goal events when `API_FOOTBALL_KEY` is
configured. Without that key, the app attempts public Sporttery score fallback
and The Odds API score fallback where available. Fallback score sources can add
scorelines, but generally not full goal-event timelines.

One-shot result collection is available with:

```bash
npm run results
```

The priority order is:

1. API-Football, when `API_FOOTBALL_KEY` is configured. This is the preferred
   source for scorelines and goal-event timelines.
2. Sporttery public scores. This is opportunistic and may return no rows for the
   current date range.
3. The Odds API scores, when `ODDS_API_KEY` is configured. This can backfill
   completed-match scorelines, but it is score-only.

The collectors write freshness and match-count metadata into `meta`, including
`api_football_last_call`, `sporttery_results_last_call`,
`oddsapi_scores_last_call`, and each source's `*_rows` / `*_matched` counters.
`/api/match-events?fk=<fixture_key>` exposes those values under
`configured.sources`, so the UI can distinguish "source has never run" from
"source ran but matched zero rows".

## Freshness And Health

`npm run health` checks source freshness, fixture merge quality, coverage, and
known split risks. Warnings can be acceptable when a low-frequency or manually
triggered source is stale, but FAIL results should be investigated before a demo
or public release.
