import { KALSHI_POLL_MS, ODDS_API_KEY, ODDSAPI_POLL_MS, PM_POLL_MS, SPORTTERY_POLL_MS } from "../config.js";
import { db, getMeta } from "../db.js";
import { fixtureTeamDayKey, isSameFixtureWindow } from "../fixtures.js";

// Phase A 健康检查核心逻辑。CLI 壳在 src/health.ts,dashboard 直接复用本模块。

export type Level = "pass" | "warn" | "fail";

export interface Check {
  level: Level;
  message: string;
}

export interface HealthReport {
  checks: Check[];
  counts: Record<Level, number>;
}

const PM_MATCH_TYPES = "('home_win_binary','draw_binary','away_win_binary')";
const PM_STALE_MS = Math.max(PM_POLL_MS * 3, 15 * 60 * 1000);
const KALSHI_STALE_MS = Math.max(KALSHI_POLL_MS * 3, 15 * 60 * 1000);
const SPORTTERY_STALE_MS = Math.max(SPORTTERY_POLL_MS * 2, 2 * 60 * 60 * 1000);

function one<T>(sql: string): T {
  return db.prepare(sql).get() as T;
}

function ageMs(raw: string | null): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : Date.now() - t;
}

interface EventSourceRow {
  id: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
  fixture_key: string | null;
  sources: string | null;
}

function findApproximateFixtureSplits(): string[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.home_team, e.away_team, e.kickoff_utc, e.fixture_key, group_concat(DISTINCT m.source) AS sources
       FROM event e
       LEFT JOIN market m ON m.event_id=e.id
       WHERE e.fixture_key IS NOT NULL AND e.fixture_key<>''
       GROUP BY e.id`
    )
    .all() as EventSourceRow[];
  const byTeamDay = new Map<string, EventSourceRow[]>();
  for (const row of rows) {
    const key = fixtureTeamDayKey(row.home_team, row.away_team, row.kickoff_utc);
    byTeamDay.set(key, [...(byTeamDay.get(key) ?? []), row]);
  }

  const splits: string[] = [];
  for (const group of byTeamDay.values()) {
    const sorted = [...group].sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc) || a.id.localeCompare(b.id));
    let cluster: EventSourceRow[] = [];
    const flush = (): void => {
      if (cluster.length === 0) return;
      const keys = [...new Set(cluster.map((row) => row.fixture_key).filter((key): key is string => Boolean(key)))];
      if (keys.length > 1) {
        const sample = cluster
          .map((row) => `${row.home_team} vs ${row.away_team}@${row.kickoff_utc} [${row.sources ?? "event-only"}]`)
          .join(" | ");
        splits.push(`${sample} => ${keys.join(", ")}`);
      }
      cluster = [];
    };

    for (const row of sorted) {
      const prev = cluster[cluster.length - 1];
      if (prev && !isSameFixtureWindow(prev.kickoff_utc, row.kickoff_utc)) flush();
      cluster.push(row);
    }
    flush();
  }
  return splits;
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 0) return "future";
  const minutes = Math.round(ms / 60000);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 72) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

interface SourceCoverage {
  pm_match_fixtures: number;
  book_fixtures: number;
  sporttery_had_fixtures: number;
  sporttery_hhad_fixtures: number;
}

export function runHealthChecks(): HealthReport {
  const checks: Check[] = [];
  const add = (level: Level, message: string): void => {
    checks.push({ level, message });
  };

  const eventCounts = one<{ events: number; fixtures: number; missing_fixture_keys: number }>(
    `SELECT COUNT(*) AS events,
            COUNT(DISTINCT fixture_key) AS fixtures,
            COALESCE(SUM(CASE WHEN fixture_key IS NULL OR fixture_key='' THEN 1 ELSE 0 END), 0) AS missing_fixture_keys
     FROM event`
  );
  if (eventCounts.missing_fixture_keys > 0) {
    add("fail", `event.fixture_key missing for ${eventCounts.missing_fixture_keys} rows`);
  } else {
    add("pass", `fixture keys present for ${eventCounts.events} source rows (${eventCounts.fixtures} fixtures)`);
  }

  const approximateSplits = findApproximateFixtureSplits();
  if (approximateSplits.length > 0) {
    add("fail", `approximate fixture splits detected: ${approximateSplits.slice(0, 3).join(" ; ")}`);
  } else {
    add("pass", "approximate fixture merge check clean (same teams within 45m share one fixture_key)");
  }

  const sportteryOrphans = one<{ n: number }>(`SELECT COUNT(*) AS n FROM event WHERE id LIKE 'sporttery-%'`).n;
  if (sportteryOrphans > 0) {
    add("fail", `sporttery created ${sportteryOrphans} standalone event rows; check team aliases/fixture matching`);
  } else {
    add("pass", "sporttery data is attached to existing fixtures");
  }

  const coverage = one<SourceCoverage>(
    `SELECT
       COUNT(DISTINCT CASE WHEN m.source='polymarket' AND m.market_type IN ${PM_MATCH_TYPES} THEN e.fixture_key END) AS pm_match_fixtures,
       COUNT(DISTINCT CASE WHEN m.source NOT IN ('polymarket','kalshi','sporttery') AND m.market_type='1x2' THEN e.fixture_key END) AS book_fixtures,
       COUNT(DISTINCT CASE WHEN m.source='sporttery' AND m.market_type='sporttery_had' THEN e.fixture_key END) AS sporttery_had_fixtures,
       COUNT(DISTINCT CASE WHEN m.source='sporttery' AND m.market_type='sporttery_hhad' THEN e.fixture_key END) AS sporttery_hhad_fixtures
     FROM market m
     LEFT JOIN event e ON e.id=m.event_id`
  );
  if (coverage.pm_match_fixtures === 0) {
    add("fail", "polymarket match fixture coverage is empty");
  } else if (coverage.pm_match_fixtures < 70) {
    add("warn", `polymarket match fixture coverage is ${coverage.pm_match_fixtures}; expected around 70 in Phase A`);
  } else {
    add("pass", `polymarket match fixture coverage: ${coverage.pm_match_fixtures}`);
  }

  if (coverage.book_fixtures === 0) {
    add("warn", "no sportsbook 1X2 fixture coverage; Odds API may be disabled or not bootstrapped");
  } else {
    add("pass", `sportsbook 1X2 fixture coverage: ${coverage.book_fixtures}`);
  }

  if (coverage.sporttery_had_fixtures === 0 && coverage.sporttery_hhad_fixtures === 0) {
    add("warn", "no sporttery fixtures yet; run npm run fetch:sporttery manually when needed");
  } else {
    add("pass", `sporttery coverage: HAD=${coverage.sporttery_had_fixtures}, HHAD=${coverage.sporttery_hhad_fixtures}`);
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
    add("fail", "polymarket match snapshots are missing");
  } else if (pmAge > PM_STALE_MS) {
    add("fail", `polymarket match snapshots are stale: latest=${pmLatest} age=${fmtAge(pmAge)}`);
  } else {
    add("pass", `polymarket match latest=${pmLatest} age=${fmtAge(pmAge)}`);
  }

  const oddsLast = getMeta("oddsapi_last_call");
  const oddsAge = ageMs(oddsLast);
  if (!ODDS_API_KEY) {
    add("warn", "ODDS_API_KEY is not set; sportsbook polling is disabled");
  } else if (!oddsLast || oddsAge === null) {
    add("warn", "Odds API has not been called yet");
  } else if (oddsAge > ODDSAPI_POLL_MS * 2) {
    add("warn", `Odds API last call is stale: latest=${oddsLast} age=${fmtAge(oddsAge)}`);
  } else {
    add("pass", `Odds API last call=${oddsLast} age=${fmtAge(oddsAge)}`);
  }

  // Kalshi 是观察期新源:stale 给 warn 不给 fail,避免链路抖动误报
  const kalshiLast = getMeta("kalshi_last_call");
  const kalshiAge = ageMs(kalshiLast);
  if (!kalshiLast || kalshiAge === null) {
    add("warn", "kalshi has not been polled yet");
  } else if (kalshiAge > KALSHI_STALE_MS) {
    add("warn", `kalshi last poll is stale: latest=${kalshiLast} age=${fmtAge(kalshiAge)}`);
  } else {
    add("pass", `kalshi last poll=${kalshiLast} age=${fmtAge(kalshiAge)}`);
  }

  const sportteryLast = getMeta("sporttery_last_call");
  const sportteryAge = ageMs(sportteryLast);
  if (!sportteryLast || sportteryAge === null) {
    add("warn", "sporttery has not been fetched yet; daemon should poll it hourly");
  } else if (sportteryAge > SPORTTERY_STALE_MS) {
    add("warn", `sporttery last fetch is stale: latest=${sportteryLast} age=${fmtAge(sportteryAge)}`);
  } else {
    add("pass", `sporttery last fetch=${sportteryLast} age=${fmtAge(sportteryAge)}`);
  }

  const counts = checks.reduce<Record<Level, number>>(
    (acc, check) => {
      acc[check.level]++;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 }
  );

  return { checks, counts };
}

// 各源数据年龄(dashboard 顶部新鲜度 chips)
export interface SourceFreshness {
  group: string;
  latest: string | null;
  ageMs: number | null;
  staleMs: number; // 超过即视为过期(红)
}

const freshnessStmt = db.prepare(
  `SELECT
     MAX(CASE WHEN m.source='polymarket' THEN s.ts END) AS pm,
     MAX(CASE WHEN m.source='kalshi' THEN s.ts END) AS kalshi,
     MAX(CASE WHEN m.source NOT IN ('polymarket','kalshi','sporttery') THEN s.ts END) AS books,
     MAX(CASE WHEN m.source='sporttery' THEN s.ts END) AS sporttery
   FROM snapshot s
   JOIN outcome o ON o.id=s.outcome_id
   JOIN market m ON m.id=o.market_id`
);

export function getSourceFreshness(): SourceFreshness[] {
  const row = freshnessStmt.get() as { pm: string | null; kalshi: string | null; books: string | null; sporttery: string | null };
  const entries: [string, string | null, number][] = [
    ["Polymarket", row.pm, PM_STALE_MS],
    ["Kalshi", row.kalshi, KALSHI_STALE_MS],
    ["书商", row.books, ODDSAPI_POLL_MS * 2],
    ["体彩", row.sporttery, SPORTTERY_STALE_MS],
  ];
  return entries.map(([group, latest, staleMs]) => ({ group, latest, ageMs: ageMs(latest), staleMs }));
}
