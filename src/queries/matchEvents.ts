import { API_FOOTBALL_KEY, ODDS_API_KEY } from "../config.js";
import { db } from "../db.js";

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
  };
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
  ["oddsapi", 1],
]);

const resultStmt = db.prepare(
  `SELECT *
   FROM match_result
   WHERE fixture_key=?
   ORDER BY
     CASE source WHEN 'api_football' THEN 0 WHEN 'oddsapi' THEN 1 ELSE 9 END,
     datetime(COALESCE(last_update_ts, created_at)) DESC,
     id DESC`
);

const eventStmt = db.prepare(
  `SELECT *
   FROM match_event
   WHERE fixture_key=?
   ORDER BY
     CASE source WHEN 'api_football' THEN 0 WHEN 'oddsapi' THEN 1 ELSE 9 END,
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

export function getMatchEventBundle(fixtureKey: string): MatchEventBundle {
  const results = (resultStmt.all(fixtureKey) as RawResultRow[]).map(resultRow);
  const result = results[0] ?? null;
  const preferredSource = result?.source ?? "api_football";
  const events = (eventStmt.all(fixtureKey) as RawEventRow[])
    .map(eventRow)
    .filter((event) => !result || sourceRank(event.source) <= sourceRank(preferredSource));
  return {
    result,
    results,
    events,
    configured: {
      apiFootball: Boolean(API_FOOTBALL_KEY),
      oddsApiScores: Boolean(ODDS_API_KEY),
    },
  };
}
