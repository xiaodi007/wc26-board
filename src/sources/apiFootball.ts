import { API_FOOTBALL_BASE, API_FOOTBALL_KEY, API_FOOTBALL_LEAGUE, API_FOOTBALL_SEASON, log } from "../config.js";
import { db, setMeta, upsertMatchEvents, upsertMatchResult, type MatchEventInput } from "../db.js";
import { fetchJsonWithHeaders } from "../http.js";
import { FIXTURE_MERGE_WINDOW_MS, kickoffDiffMs } from "../fixtures.js";
import { teamsMatch } from "../teams.js";

interface ApiFootballResponse<T> {
  response: T[];
  errors?: unknown;
}

interface ApiFootballFixture {
  fixture: {
    id: number;
    date: string;
    timestamp?: number;
    status?: {
      long?: string;
      short?: string;
      elapsed?: number | null;
      extra?: number | null;
    };
  };
  teams: {
    home: { id?: number; name: string; winner?: boolean | null };
    away: { id?: number; name: string; winner?: boolean | null };
  };
  goals?: {
    home?: number | null;
    away?: number | null;
  };
}

interface ApiFootballEvent {
  time?: { elapsed?: number | null; extra?: number | null };
  team?: { id?: number; name?: string };
  player?: { id?: number; name?: string };
  assist?: { id?: number; name?: string | null };
  type?: string;
  detail?: string;
  comments?: string | null;
}

interface LocalFixtureRow {
  fixture_key: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
}

interface FixtureMatch {
  local: LocalFixtureRow;
  orientation: "normal" | "reversed";
  diffMs: number;
}

const targetFixturesStmt = db.prepare(
  `WITH candidates AS (
     SELECT
       e.fixture_key,
       e.home_team,
       e.away_team,
       e.kickoff_utc,
       ROW_NUMBER() OVER (
         PARTITION BY e.fixture_key
         ORDER BY
           CASE
             WHEN EXISTS (
               SELECT 1 FROM market bm
               WHERE bm.event_id=e.id
                 AND bm.source NOT IN ('polymarket','kalshi','sporttery')
             ) THEN 0
             WHEN e.id NOT LIKE 'pm-%' AND e.id NOT LIKE 'sporttery-%' THEN 1
             WHEN e.id LIKE 'pm-%' THEN 2
             ELSE 3
           END,
           datetime(e.kickoff_utc),
           e.id
       ) AS rn
     FROM event e
     WHERE datetime(e.kickoff_utc) >= datetime('now', '-3 days')
       AND datetime(e.kickoff_utc) <= datetime('now', '+4 hours')
   )
   SELECT fixture_key, home_team, away_team, kickoff_utc
   FROM candidates
   WHERE rn=1
   ORDER BY datetime(kickoff_utc)`
);

function apiUrl(pathname: string, params: Record<string, string | number>): string {
  const url = new URL(pathname, API_FOOTBALL_BASE.endsWith("/") ? API_FOOTBALL_BASE : `${API_FOOTBALL_BASE}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function apiGet<T>(pathname: string, params: Record<string, string | number>, label: string): Promise<T[]> {
  if (!API_FOOTBALL_KEY) return [];
  const { data } = await fetchJsonWithHeaders<ApiFootballResponse<T>>(apiUrl(pathname, params), label, {
    "x-apisports-key": API_FOOTBALL_KEY,
  });
  return Array.isArray(data.response) ? data.response : [];
}

function dateKey(kickoffUtc: string): string {
  const ts = Date.parse(kickoffUtc);
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : kickoffUtc.slice(0, 10);
}

function fixtureDates(rows: LocalFixtureRow[]): string[] {
  return [...new Set(rows.map((row) => dateKey(row.kickoff_utc)).filter(Boolean))].sort();
}

function matchLocalFixture(api: ApiFootballFixture, locals: LocalFixtureRow[]): FixtureMatch | null {
  const apiKickoff = api.fixture.date;
  const matches: FixtureMatch[] = [];
  for (const local of locals) {
    const diff = kickoffDiffMs(local.kickoff_utc, apiKickoff);
    if (diff === null || diff > FIXTURE_MERGE_WINDOW_MS) continue;
    const normal = teamsMatch(api.teams.home.name, local.home_team) && teamsMatch(api.teams.away.name, local.away_team);
    const reversed = teamsMatch(api.teams.home.name, local.away_team) && teamsMatch(api.teams.away.name, local.home_team);
    if (normal || reversed) matches.push({ local, orientation: normal ? "normal" : "reversed", diffMs: diff });
  }
  return matches.sort((a, b) => a.diffMs - b.diffMs)[0] ?? null;
}

function scoreForLocal(api: ApiFootballFixture, orientation: "normal" | "reversed"): { home: number | null; away: number | null } {
  const home = api.goals?.home ?? null;
  const away = api.goals?.away ?? null;
  return orientation === "normal" ? { home, away } : { home: away, away: home };
}

function winnerForScore(score: { home: number | null; away: number | null }): "home" | "draw" | "away" | null {
  if (score.home === null || score.away === null) return null;
  if (score.home > score.away) return "home";
  if (score.home < score.away) return "away";
  return "draw";
}

function hasStarted(api: ApiFootballFixture): boolean {
  const short = api.fixture.status?.short ?? "";
  return !["", "NS", "TBD", "PST", "CANC"].includes(short);
}

function eventKey(event: ApiFootballEvent, index: number): string {
  const parts = [
    event.time?.elapsed ?? "",
    event.time?.extra ?? "",
    event.team?.name ?? "",
    event.type ?? "",
    event.detail ?? "",
    event.player?.name ?? "",
    event.assist?.name ?? "",
    event.comments ?? "",
    index,
  ];
  return parts.join("|");
}

function apiTeamSide(api: ApiFootballFixture, event: ApiFootballEvent): "home" | "away" | "unknown" {
  const name = event.team?.name ?? "";
  if (!name) return "unknown";
  if (teamsMatch(name, api.teams.home.name)) return "home";
  if (teamsMatch(name, api.teams.away.name)) return "away";
  return "unknown";
}

function localSide(apiSide: "home" | "away" | "unknown", orientation: "normal" | "reversed"): "home" | "away" | "unknown" {
  if (apiSide === "unknown") return "unknown";
  if (orientation === "normal") return apiSide;
  return apiSide === "home" ? "away" : "home";
}

function scoringSide(teamSide: "home" | "away" | "unknown", detail: string | undefined): "home" | "away" | "unknown" {
  if (teamSide === "unknown") return "unknown";
  if (/own goal/i.test(detail ?? "")) return teamSide === "home" ? "away" : "home";
  return teamSide;
}

function isScoringEvent(event: ApiFootballEvent): boolean {
  if ((event.type ?? "").toLowerCase() !== "goal") return false;
  return !/(missed|cancelled|canceled|disallowed)/i.test(event.detail ?? "");
}

function buildEvents(api: ApiFootballFixture, match: FixtureMatch, events: ApiFootballEvent[]): MatchEventInput[] {
  let homeScore = 0;
  let awayScore = 0;
  const sorted = [...events].sort(
    (a, b) =>
      Number(a.time?.elapsed ?? 999) - Number(b.time?.elapsed ?? 999) ||
      Number(a.time?.extra ?? 0) - Number(b.time?.extra ?? 0)
  );

  return sorted.map((event, index) => {
    const apiSide = apiTeamSide(api, event);
    const teamSide = localSide(apiSide, match.orientation);
    let scoreHome: number | null = null;
    let scoreAway: number | null = null;
    if (isScoringEvent(event)) {
      const side = scoringSide(teamSide, event.detail);
      if (side === "home") homeScore += 1;
      if (side === "away") awayScore += 1;
      if (side !== "unknown") {
        scoreHome = homeScore;
        scoreAway = awayScore;
      }
    }
    return {
      fixtureKey: match.local.fixture_key,
      source: "api_football",
      sourceFixtureId: String(api.fixture.id),
      eventKey: eventKey(event, index),
      minute: event.time?.elapsed ?? null,
      extraMinute: event.time?.extra ?? null,
      teamSide,
      teamName: event.team?.name ?? null,
      playerName: event.player?.name ?? null,
      assistName: event.assist?.name ?? null,
      eventType: event.type ?? null,
      detail: event.detail ?? null,
      scoreHome,
      scoreAway,
      rawJson: JSON.stringify(event),
    };
  });
}

export async function pollApiFootballResults(): Promise<number> {
  if (!API_FOOTBALL_KEY) return 0;
  const locals = targetFixturesStmt.all() as LocalFixtureRow[];
  if (!locals.length) return 0;

  const fixtures: ApiFootballFixture[] = [];
  for (const date of fixtureDates(locals)) {
    fixtures.push(
      ...(await apiGet<ApiFootballFixture>(
        "/fixtures",
        { league: API_FOOTBALL_LEAGUE, season: API_FOOTBALL_SEASON, date, timezone: "UTC" },
        `api-football/fixtures/${date}`
      ))
    );
  }

  let matched = 0;
  let eventRows = 0;
  const now = new Date().toISOString();
  const unmatched = new Set<string>();
  for (const api of fixtures) {
    const match = matchLocalFixture(api, locals);
    if (!match) {
      unmatched.add(`${api.teams.home.name} vs ${api.teams.away.name} ${api.fixture.date}`);
      continue;
    }

    const score = scoreForLocal(api, match.orientation);
    const status = api.fixture.status?.short ?? api.fixture.status?.long ?? null;
    upsertMatchResult({
      fixtureKey: match.local.fixture_key,
      source: "api_football",
      sourceFixtureId: String(api.fixture.id),
      status,
      elapsed: api.fixture.status?.elapsed ?? null,
      homeScore: score.home,
      awayScore: score.away,
      winner: winnerForScore(score),
      lastUpdateTs: now,
      rawJson: JSON.stringify(api),
    });
    matched += 1;

    if (hasStarted(api)) {
      const events = await apiGet<ApiFootballEvent>("/fixtures/events", { fixture: api.fixture.id }, `api-football/events/${api.fixture.id}`);
      eventRows += upsertMatchEvents(buildEvents(api, match, events));
    }
  }

  setMeta("api_football_last_call", now);
  setMeta("results_last_call", now);
  if (unmatched.size) log(`api-football: unmatched fixtures skipped: ${[...unmatched].slice(0, 8).join(" ; ")}`);
  log(`api-football: matched ${matched}/${fixtures.length} fixtures, upserted ${eventRows} events`);
  return matched + eventRows;
}
