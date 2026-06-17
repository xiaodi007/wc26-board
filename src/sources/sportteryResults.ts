import { fetchJsonWithHeaders } from "../http.js";
import { db, setMeta, upsertMatchResult } from "../db.js";
import { FIXTURE_MERGE_WINDOW_MS, kickoffDiffMs } from "../fixtures.js";
import { log } from "../config.js";
import { teamsMatch } from "../teams.js";

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

const SPORTTERY_RESULTS_URL = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchResultV1.qry";

const REQUEST_HEADERS = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Origin: "https://www.sporttery.cn",
  Referer: "https://www.sporttery.cn/jc/zqsgkj/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const targetFixturesStmt = db.prepare(
  `WITH candidates AS (
     SELECT
       e.fixture_key,
       e.home_team,
       e.away_team,
       e.kickoff_utc,
       ROW_NUMBER() OVER (
         PARTITION BY e.fixture_key
         ORDER BY datetime(e.kickoff_utc), e.id
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

function dateKey(kickoffUtc: string): string {
  const ts = Date.parse(kickoffUtc);
  return Number.isFinite(ts) ? new Date(ts + 8 * 3600_000).toISOString().slice(0, 10) : kickoffUtc.slice(0, 10);
}

function localDateRange(rows: LocalFixtureRow[]): { begin: string; end: string } | null {
  const dates = rows.map((row) => dateKey(row.kickoff_utc)).filter(Boolean).sort();
  if (!dates.length) return null;
  return { begin: dates[0], end: dates[dates.length - 1] };
}

function resultUrl(begin: string, end: string): string {
  const url = new URL(SPORTTERY_RESULTS_URL);
  url.searchParams.set("matchPage", "1");
  url.searchParams.set("matchBeginDate", begin);
  url.searchParams.set("matchEndDate", end);
  url.searchParams.set("leagueId", "");
  url.searchParams.set("pageSize", "200");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("isFix", "1");
  url.searchParams.set("pcOrWap", "1");
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function numberField(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function kickoffUtc(row: Record<string, unknown>): string | null {
  const date = stringField(row, ["matchDate", "match_date", "businessDate", "date"]);
  const time = stringField(row, ["matchTime", "match_time", "startTime", "kickoffTime", "time"]);
  if (!date || !time) return null;
  const d = new Date(`${date.slice(0, 10)}T${time.slice(0, 8)}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function score(row: Record<string, unknown>): { home: number | null; away: number | null } | null {
  const home = numberField(row, ["homeScore", "home_score", "homeTeamScore", "homeFullScore", "hostScore", "hscore", "homeGoal", "homeGoals"]);
  const away = numberField(row, ["awayScore", "away_score", "awayTeamScore", "awayFullScore", "guestScore", "ascore", "awayGoal", "awayGoals"]);
  if (home !== null || away !== null) return { home, away };
  const raw = stringField(row, ["score", "matchScore", "fullScore", "finalScore", "bf", "result", "matchResult", "allScore"]);
  const m = raw?.match(/(\d+)\s*[-:：]\s*(\d+)/);
  return m ? { home: Number(m[1]), away: Number(m[2]) } : null;
}

function winner(home: number | null, away: number | null): "home" | "draw" | "away" | null {
  if (home === null || away === null) return null;
  if (home > away) return "home";
  if (home < away) return "away";
  return "draw";
}

function status(row: Record<string, unknown>, hasScore: boolean): string | null {
  const raw = stringField(row, ["status", "matchStatus", "statusDesc", "matchState", "state"]);
  if (!raw && hasScore) return "FT";
  if (!raw) return null;
  if (/完|结束|已开奖|final|ft/i.test(raw)) return "FT";
  return raw;
}

function homeName(row: Record<string, unknown>): string | null {
  return stringField(row, ["homeTeamAllName", "homeTeamName", "homeName", "home_team", "hostTeam", "hostName"]);
}

function awayName(row: Record<string, unknown>): string | null {
  return stringField(row, ["awayTeamAllName", "awayTeamName", "awayName", "away_team", "guestTeam", "guestName"]);
}

function matchId(row: Record<string, unknown>): string | null {
  return stringField(row, ["matchId", "matchNum", "matchNumStr", "id"]);
}

function looksLikeMatch(row: Record<string, unknown>): boolean {
  return Boolean(homeName(row) && awayName(row) && kickoffUtc(row) && score(row));
}

function collectMatches(raw: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    for (const item of raw) collectMatches(item, out);
    return out;
  }
  const row = asRecord(raw);
  if (!row) return out;
  if (looksLikeMatch(row)) out.push(row);
  for (const value of Object.values(row)) {
    if (Array.isArray(value)) collectMatches(value, out);
    else if (asRecord(value)) collectMatches(value, out);
  }
  return out;
}

function matchLocalFixture(row: Record<string, unknown>, locals: LocalFixtureRow[]): FixtureMatch | null {
  const home = homeName(row);
  const away = awayName(row);
  const kickoff = kickoffUtc(row);
  if (!home || !away || !kickoff) return null;
  const matches: FixtureMatch[] = [];
  for (const local of locals) {
    const diff = kickoffDiffMs(local.kickoff_utc, kickoff);
    if (diff === null || diff > FIXTURE_MERGE_WINDOW_MS) continue;
    const normal = teamsMatch(home, local.home_team) && teamsMatch(away, local.away_team);
    const reversed = teamsMatch(home, local.away_team) && teamsMatch(away, local.home_team);
    if (normal || reversed) matches.push({ local, orientation: normal ? "normal" : "reversed", diffMs: diff });
  }
  return matches.sort((a, b) => a.diffMs - b.diffMs)[0] ?? null;
}

export async function pollSportteryResults(): Promise<number> {
  const now = new Date().toISOString();
  const locals = targetFixturesStmt.all() as LocalFixtureRow[];
  const range = localDateRange(locals);
  if (!locals.length || !range) {
    setMeta("sporttery_results_last_call", now);
    setMeta("sporttery_results_rows", "0");
    setMeta("sporttery_results_matched", "0");
    log("sporttery results: no local completed fixtures in polling window");
    return 0;
  }

  const { data } = await fetchJsonWithHeaders<unknown>(resultUrl(range.begin, range.end), "sporttery/getMatchResultV1", REQUEST_HEADERS);
  const rows = collectMatches(data);
  let matched = 0;
  for (const row of rows) {
    const match = matchLocalFixture(row, locals);
    if (!match) continue;
    const rawScore = score(row);
    if (!rawScore) continue;
    const localScore =
      match.orientation === "normal"
        ? rawScore
        : {
            home: rawScore.away,
            away: rawScore.home,
          };
    upsertMatchResult({
      fixtureKey: match.local.fixture_key,
      source: "sporttery_results",
      sourceFixtureId: matchId(row),
      status: status(row, localScore.home !== null || localScore.away !== null),
      elapsed: null,
      homeScore: localScore.home,
      awayScore: localScore.away,
      winner: winner(localScore.home, localScore.away),
      lastUpdateTs: now,
      rawJson: JSON.stringify(row),
    });
    matched += 1;
  }
  setMeta("sporttery_results_last_call", now);
  setMeta("sporttery_results_rows", String(rows.length));
  setMeta("sporttery_results_matched", String(matched));
  setMeta("results_last_call", now);
  log(`sporttery results: matched ${matched}/${rows.length} rows`);
  return matched;
}
