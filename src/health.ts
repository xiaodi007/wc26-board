import { KALSHI_POLL_MS, ODDS_API_KEY, ODDSAPI_POLL_MS, PM_POLL_MS } from "./config.js";
import { db, getMeta } from "./db.js";

type Level = "pass" | "warn" | "fail";

interface Check {
  level: Level;
  message: string;
}

interface SourceCoverage {
  pm_match_fixtures: number;
  book_fixtures: number;
  sporttery_had_fixtures: number;
  sporttery_hhad_fixtures: number;
}

const PM_MATCH_TYPES = "('home_win_binary','draw_binary','away_win_binary')";
const PM_STALE_MS = Math.max(PM_POLL_MS * 3, 15 * 60 * 1000);
const SPORTTERY_STALE_MS = 24 * 60 * 60 * 1000;

function one<T>(sql: string): T {
  return db.prepare(sql).get() as T;
}

function nowMs(): number {
  return Date.now();
}

function ageMs(raw: string | null): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : nowMs() - t;
}

function fmtAge(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 0) return "future";
  const minutes = Math.round(ms / 60000);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 72) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function add(checks: Check[], level: Level, message: string): void {
  checks.push({ level, message });
}

const checks: Check[] = [];

const eventCounts = one<{ events: number; fixtures: number; missing_fixture_keys: number }>(
  `SELECT COUNT(*) AS events,
          COUNT(DISTINCT fixture_key) AS fixtures,
          COALESCE(SUM(CASE WHEN fixture_key IS NULL OR fixture_key='' THEN 1 ELSE 0 END), 0) AS missing_fixture_keys
   FROM event`
);
if (eventCounts.missing_fixture_keys > 0) {
  add(checks, "fail", `event.fixture_key missing for ${eventCounts.missing_fixture_keys} rows`);
} else {
  add(checks, "pass", `fixture keys present for ${eventCounts.events} source rows (${eventCounts.fixtures} fixtures)`);
}

const sportteryOrphans = one<{ n: number }>(`SELECT COUNT(*) AS n FROM event WHERE id LIKE 'sporttery-%'`).n;
if (sportteryOrphans > 0) {
  add(checks, "fail", `sporttery created ${sportteryOrphans} standalone event rows; check team aliases/fixture matching`);
} else {
  add(checks, "pass", "sporttery data is attached to existing fixtures");
}

const coverage = one<SourceCoverage>(
  `SELECT
     COUNT(DISTINCT CASE WHEN m.source='polymarket' AND m.market_type IN ${PM_MATCH_TYPES} THEN e.fixture_key END) AS pm_match_fixtures,
     COUNT(DISTINCT CASE WHEN m.source NOT IN ('polymarket','sporttery') AND m.market_type='1x2' THEN e.fixture_key END) AS book_fixtures,
     COUNT(DISTINCT CASE WHEN m.source='sporttery' AND m.market_type='sporttery_had' THEN e.fixture_key END) AS sporttery_had_fixtures,
     COUNT(DISTINCT CASE WHEN m.source='sporttery' AND m.market_type='sporttery_hhad' THEN e.fixture_key END) AS sporttery_hhad_fixtures
   FROM market m
   LEFT JOIN event e ON e.id=m.event_id`
);
if (coverage.pm_match_fixtures === 0) {
  add(checks, "fail", "polymarket match fixture coverage is empty");
} else if (coverage.pm_match_fixtures < 70) {
  add(checks, "warn", `polymarket match fixture coverage is ${coverage.pm_match_fixtures}; expected around 70 in Phase A`);
} else {
  add(checks, "pass", `polymarket match fixture coverage: ${coverage.pm_match_fixtures}`);
}

if (coverage.book_fixtures === 0) {
  add(checks, "warn", "no sportsbook 1X2 fixture coverage; Odds API may be disabled or not bootstrapped");
} else {
  add(checks, "pass", `sportsbook 1X2 fixture coverage: ${coverage.book_fixtures}`);
}

if (coverage.sporttery_had_fixtures === 0 && coverage.sporttery_hhad_fixtures === 0) {
  add(checks, "warn", "no sporttery fixtures yet; run npm run fetch:sporttery manually when needed");
} else {
  add(
    checks,
    "pass",
    `sporttery coverage: HAD=${coverage.sporttery_had_fixtures}, HHAD=${coverage.sporttery_hhad_fixtures}`
  );
}

const pmLatest = one<{ latest: string | null }>(
  `SELECT MAX(s.ts) AS latest
   FROM snapshot s
   JOIN outcome o ON o.id=s.outcome_id
   JOIN market m ON m.id=o.market_id
   WHERE m.source='polymarket'
     AND m.market_type IN ${PM_MATCH_TYPES}`
).latest;
const pmAge = ageMs(pmLatest);
if (!pmLatest || pmAge === null) {
  add(checks, "fail", "polymarket match snapshots are missing");
} else if (pmAge > PM_STALE_MS) {
  add(checks, "fail", `polymarket match snapshots are stale: latest=${pmLatest} age=${fmtAge(pmAge)}`);
} else {
  add(checks, "pass", `polymarket match latest=${pmLatest} age=${fmtAge(pmAge)}`);
}

const oddsLast = getMeta("oddsapi_last_call");
const oddsAge = ageMs(oddsLast);
if (!ODDS_API_KEY) {
  add(checks, "warn", "ODDS_API_KEY is not set; sportsbook polling is disabled");
} else if (!oddsLast || oddsAge === null) {
  add(checks, "warn", "Odds API has not been called yet");
} else if (oddsAge > ODDSAPI_POLL_MS * 2) {
  add(checks, "warn", `Odds API last call is stale: latest=${oddsLast} age=${fmtAge(oddsAge)}`);
} else {
  add(checks, "pass", `Odds API last call=${oddsLast} age=${fmtAge(oddsAge)}`);
}

// Kalshi 是观察期新源:stale 给 warn 不给 fail,避免链路抖动误报
const kalshiLast = getMeta("kalshi_last_call");
const kalshiAge = ageMs(kalshiLast);
const kalshiStaleMs = Math.max(KALSHI_POLL_MS * 3, 15 * 60 * 1000);
if (!kalshiLast || kalshiAge === null) {
  add(checks, "warn", "kalshi has not been polled yet");
} else if (kalshiAge > kalshiStaleMs) {
  add(checks, "warn", `kalshi last poll is stale: latest=${kalshiLast} age=${fmtAge(kalshiAge)}`);
} else {
  add(checks, "pass", `kalshi last poll=${kalshiLast} age=${fmtAge(kalshiAge)}`);
}

const sportteryLast = getMeta("sporttery_last_call");
const sportteryAge = ageMs(sportteryLast);
if (!sportteryLast || sportteryAge === null) {
  add(checks, "warn", "sporttery has not been fetched yet; this is manual-low-frequency by design");
} else if (sportteryAge > SPORTTERY_STALE_MS) {
  add(checks, "warn", `sporttery last fetch is stale: latest=${sportteryLast} age=${fmtAge(sportteryAge)}`);
} else {
  add(checks, "pass", `sporttery last fetch=${sportteryLast} age=${fmtAge(sportteryAge)}`);
}

const counts = checks.reduce<Record<Level, number>>(
  (acc, check) => {
    acc[check.level]++;
    return acc;
  },
  { pass: 0, warn: 0, fail: 0 }
);

console.log("Phase A health");
for (const check of checks) {
  console.log(`${check.level.toUpperCase()} ${check.message}`);
}
console.log(`summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);

if (counts.fail > 0) process.exitCode = 1;
