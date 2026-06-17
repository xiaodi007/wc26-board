import { fetchJsonWithHeaders } from "../http.js";
import { ODDS_API_KEY, ODDSAPI_BASE, ODDSAPI_SPORT, ODDSAPI_REGIONS, ODDSAPI_MARKETS, log } from "../config.js";
import { eventFixtureKey, upsertEvent, getOrCreateMarket, getOrCreateOutcome, insertSnapshots, setMeta, upsertMatchResult, type SnapshotRow } from "../db.js";
import { decimalToProb } from "../normalize.js";

interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

interface OddsApiOddsEvent extends OddsApiEvent {
  bookmakers: {
    key: string;
    title: string;
    last_update: string;
    markets: {
      key: string; // 'h2h'
      last_update: string;
      outcomes: { name: string; price: number }[];
    }[];
  }[];
}

interface OddsApiScoreEvent extends OddsApiEvent {
  completed: boolean;
  scores?: { name: string; score: string }[] | null;
  last_update?: string | null;
}

function recordQuota(headers: Headers, lastCallKey: string | null = "oddsapi_last_call"): void {
  const remaining = headers.get("x-requests-remaining");
  const used = headers.get("x-requests-used");
  if (remaining !== null) setMeta("oddsapi_credits_remaining", remaining);
  if (used !== null) setMeta("oddsapi_credits_used", used);
  if (lastCallKey) setMeta(lastCallKey, new Date().toISOString());
}

// /events 端点不计费(0 credit),用于赛程 bootstrap
export async function bootstrapEvents(): Promise<number> {
  if (!ODDS_API_KEY) return 0;
  const url = `${ODDSAPI_BASE}/sports/${ODDSAPI_SPORT}/events?apiKey=${ODDS_API_KEY}`;
  const { data, headers } = await fetchJsonWithHeaders<OddsApiEvent[]>(url, "oddsapi/events");
  recordQuota(headers);
  for (const ev of data) {
    upsertEvent(ev.id, ev.home_team, ev.away_team, ev.commence_time);
  }
  log(`oddsapi: bootstrapped ${data.length} events`);
  return data.length;
}

// h2h(1X2)赔率快照。1 credit/次(h2h × eu)。
export async function pollOdds(): Promise<number> {
  if (!ODDS_API_KEY) return 0;
  const url =
    `${ODDSAPI_BASE}/sports/${ODDSAPI_SPORT}/odds` +
    `?apiKey=${ODDS_API_KEY}&regions=${ODDSAPI_REGIONS}&markets=${ODDSAPI_MARKETS}&oddsFormat=decimal`;
  const { data, headers } = await fetchJsonWithHeaders<OddsApiOddsEvent[]>(url, "oddsapi/odds");
  recordQuota(headers);

  const rows: SnapshotRow[] = [];
  for (const ev of data) {
    // odds 响应自带赛程字段,顺手保活 event 表(新增的延期/改期也能跟上)
    upsertEvent(ev.id, ev.home_team, ev.away_team, ev.commence_time);
    for (const bk of ev.bookmakers) {
      for (const mk of bk.markets) {
        if (mk.key !== "h2h") continue;
        const marketId = getOrCreateMarket(bk.key, `${ev.id}:h2h`, "1x2", ev.id);
        for (const oc of mk.outcomes) {
          // The Odds API h2h outcome name = 队名 或 "Draw"
          const label =
            oc.name === "Draw" ? "draw" : oc.name === ev.home_team ? "home" : oc.name === ev.away_team ? "away" : oc.name;
          const outcomeId = getOrCreateOutcome(marketId, label);
          rows.push({
            outcomeId,
            rawPrice: JSON.stringify({ decimal: oc.price, bookmaker: bk.key }),
            probImplied: decimalToProb(oc.price),
            sourceUpdatedTs: mk.last_update,
          });
        }
      }
    }
  }
  const n = insertSnapshots(rows);
  log(`oddsapi: ${data.length} events, ${n} snapshots (credits remaining: see meta)`);
  return n;
}

function scoreForTeam(ev: OddsApiScoreEvent, team: string): number | null {
  const raw = ev.scores?.find((row) => row.name === team)?.score;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function scoreWinner(home: number | null, away: number | null): "home" | "draw" | "away" | null {
  if (home === null || away === null) return null;
  if (home > away) return "home";
  if (home < away) return "away";
  return "draw";
}

// Scores fallback: The Odds API exposes live/recent completed scores, but no goal event timeline.
export async function pollScores(): Promise<number> {
  if (!ODDS_API_KEY) return 0;
  const url = `${ODDSAPI_BASE}/sports/${ODDSAPI_SPORT}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
  const { data, headers } = await fetchJsonWithHeaders<OddsApiScoreEvent[]>(url, "oddsapi/scores");
  recordQuota(headers, null);

  let n = 0;
  const now = new Date().toISOString();
  for (const ev of data) {
    upsertEvent(ev.id, ev.home_team, ev.away_team, ev.commence_time, ev.completed ? "completed" : "scheduled");
    const fixtureKey = eventFixtureKey(ev.id);
    if (!fixtureKey) continue;
    const homeScore = scoreForTeam(ev, ev.home_team);
    const awayScore = scoreForTeam(ev, ev.away_team);
    if (homeScore === null && awayScore === null && !ev.completed) continue;
    upsertMatchResult({
      fixtureKey,
      source: "oddsapi",
      sourceFixtureId: ev.id,
      status: ev.completed ? "FT" : "LIVE",
      elapsed: null,
      homeScore,
      awayScore,
      winner: scoreWinner(homeScore, awayScore),
      lastUpdateTs: ev.last_update ?? now,
      rawJson: JSON.stringify(ev),
    });
    n += 1;
  }
  setMeta("oddsapi_scores_last_call", now);
  setMeta("oddsapi_scores_rows", String(data.length));
  setMeta("oddsapi_scores_matched", String(n));
  setMeta("results_last_call", now);
  log(`oddsapi scores: ${n}/${data.length} results upserted`);
  return n;
}
