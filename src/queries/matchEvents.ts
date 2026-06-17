import { API_FOOTBALL_KEY, ODDS_API_KEY } from "../config.js";
import { db, getMeta } from "../db.js";

export interface MatchResultRow {
  id: number;
  fixtureKey: string;
  source: string;
  sourceFixtureId: string | null;
  status: string | null;
  elapsed: number | null;
  homeScore: number | null;
  awayScore: number | null;
  winner: string | null;
  lastUpdateTs: string | null;
  rawJson: string | null;
}

export interface MatchEventRow {
  id: number;
  fixtureKey: string;
  source: string;
  sourceFixtureId: string | null;
  eventKey: string;
  minute: number | null;
  extraMinute: number | null;
  teamSide: string | null;
  teamName: string | null;
  playerName: string | null;
  assistName: string | null;
  eventType: string | null;
  detail: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  rawJson: string | null;
}

export interface MatchEventBundle {
  result: MatchResultRow | null;
  results: MatchResultRow[];
  events: MatchEventRow[];
  configured: {
    apiFootball: boolean;
    oddsApiScores: boolean;
    sportteryResults: boolean;
    sources: Record<ResultSourceId, ResultSourceStatus>;
  };
}

export type ResultSourceId = "apiFootball" | "sportteryResults" | "oddsApiScores";

export interface ResultSourceStatus {
  configured: boolean;
  available: boolean;
  lastCall: string | null;
  matchedRows: number;
  rows: number;
  providesEvents: boolean;
}

interface RawResultRow {
  id: number;
  fixture_key: string;
  source: string;
  source_fixture_id: string | null;
  status: string | null;
  elapsed: number | null;
  home_score: number | null;
  away_score: number | null;
  winner: string | null;
  last_update_ts: string | null;
  raw_json: string | null;
}

interface RawEventRow {
  id: number;
  fixture_key: string;
  source: string;
  source_fixture_id: string | null;
  event_key: string;
  minute: number | null;
  extra_minute: number | null;
  team_side: string | null;
  team_name: string | null;
  player_name: string | null;
  assist_name: string | null;
  event_type: string | null;
  detail: string | null;
  score_home: number | null;
  score_away: number | null;
  raw_json: string | null;
}

const SOURCE_PRIORITY = new Map([
  ["api_football", 0],
  ["sporttery_results", 1],
  ["oddsapi", 2],
]);

const resultStmt = db.prepare(
  `SELECT *
   FROM match_result
   WHERE fixture_key=?
   ORDER BY
     CASE source WHEN 'api_football' THEN 0 WHEN 'sporttery_results' THEN 1 WHEN 'oddsapi' THEN 2 ELSE 9 END,
     datetime(COALESCE(last_update_ts, created_at)) DESC,
     id DESC`
);

const eventStmt = db.prepare(
  `SELECT *
   FROM match_event
   WHERE fixture_key=?
   ORDER BY
     CASE source WHEN 'api_football' THEN 0 WHEN 'sporttery_results' THEN 1 WHEN 'oddsapi' THEN 2 ELSE 9 END,
     COALESCE(minute, 999),
     COALESCE(extra_minute, 0),
     id`
);

function resultRow(row: RawResultRow): MatchResultRow {
  return {
    id: row.id,
    fixtureKey: row.fixture_key,
    source: row.source,
    sourceFixtureId: row.source_fixture_id,
    status: row.status,
    elapsed: row.elapsed,
    homeScore: row.home_score,
    awayScore: row.away_score,
    winner: row.winner,
    lastUpdateTs: row.last_update_ts,
    rawJson: row.raw_json,
  };
}

function eventRow(row: RawEventRow): MatchEventRow {
  return {
    id: row.id,
    fixtureKey: row.fixture_key,
    source: row.source,
    sourceFixtureId: row.source_fixture_id,
    eventKey: row.event_key,
    minute: row.minute,
    extraMinute: row.extra_minute,
    teamSide: row.team_side,
    teamName: row.team_name,
    playerName: row.player_name,
    assistName: row.assist_name,
    eventType: row.event_type,
    detail: row.detail,
    scoreHome: row.score_home,
    scoreAway: row.score_away,
    rawJson: row.raw_json,
  };
}

function sourceRank(source: string): number {
  return SOURCE_PRIORITY.get(source) ?? 9;
}

function numberMeta(key: string): number {
  const value = Number(getMeta(key) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function sourceStatus(args: {
  configured: boolean;
  lastCallKey: string;
  matchedKey: string;
  rowsKey: string;
  providesEvents: boolean;
}): ResultSourceStatus {
  const lastCall = getMeta(args.lastCallKey);
  return {
    configured: args.configured,
    available: Boolean(lastCall),
    lastCall,
    matchedRows: numberMeta(args.matchedKey),
    rows: numberMeta(args.rowsKey),
    providesEvents: args.providesEvents,
  };
}

export function getResultSourceStatuses(): Record<ResultSourceId, ResultSourceStatus> {
  return {
    apiFootball: sourceStatus({
      configured: Boolean(API_FOOTBALL_KEY),
      lastCallKey: "api_football_last_call",
      matchedKey: "api_football_matched",
      rowsKey: "api_football_rows",
      providesEvents: true,
    }),
    sportteryResults: sourceStatus({
      configured: true,
      lastCallKey: "sporttery_results_last_call",
      matchedKey: "sporttery_results_matched",
      rowsKey: "sporttery_results_rows",
      providesEvents: false,
    }),
    oddsApiScores: sourceStatus({
      configured: Boolean(ODDS_API_KEY),
      lastCallKey: "oddsapi_scores_last_call",
      matchedKey: "oddsapi_scores_matched",
      rowsKey: "oddsapi_scores_rows",
      providesEvents: false,
    }),
  };
}

export function getMatchEventBundle(fixtureKey: string): MatchEventBundle {
  const results = (resultStmt.all(fixtureKey) as RawResultRow[]).map(resultRow);
  const result = results[0] ?? null;
  const preferredSource = result?.source ?? "api_football";
  const events = (eventStmt.all(fixtureKey) as RawEventRow[])
    .map(eventRow)
    .filter((event) => !result || sourceRank(event.source) <= sourceRank(preferredSource));
  const sources = getResultSourceStatuses();
  return {
    result,
    results,
    events,
    configured: {
      apiFootball: Boolean(API_FOOTBALL_KEY),
      oddsApiScores: Boolean(ODDS_API_KEY),
      sportteryResults: sources.sportteryResults.available,
      sources,
    },
  };
}
