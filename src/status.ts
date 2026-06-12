// 快速体检: 赛程归并 / 各源快照量 / 最新时间 / Odds API 配额余量
import { db, getMeta } from "./db.js";

const bySource = db
  .prepare(
    `SELECT m.source, COUNT(s.id) AS snaps, MAX(s.ts) AS latest, COUNT(DISTINCT o.id) AS outcomes,
            COUNT(DISTINCT e.fixture_key) AS fixtures
     FROM snapshot s JOIN outcome o ON o.id=s.outcome_id JOIN market m ON m.id=o.market_id
     LEFT JOIN event e ON e.id=m.event_id
     GROUP BY m.source ORDER BY snaps DESC`
  )
  .all() as { source: string; snaps: number; latest: string; outcomes: number; fixtures: number }[];

const events = (db.prepare(`SELECT COUNT(*) AS n FROM event`).get() as { n: number }).n;
const fixtures = (db.prepare(`SELECT COUNT(DISTINCT fixture_key) AS n FROM event`).get() as { n: number }).n;
const duplicateEvents = events - fixtures;
const next24h = db
  .prepare(`SELECT MIN(home_team || ' vs ' || away_team) AS m, MIN(kickoff_utc) AS kickoff_utc, COUNT(*) AS source_events
            FROM event
            WHERE datetime(kickoff_utc) BETWEEN datetime('now') AND datetime('now','+1 day')
            GROUP BY fixture_key
            ORDER BY datetime(MIN(kickoff_utc))`)
  .all() as { m: string; kickoff_utc: string }[];

console.log(`events: ${events} source rows, ${fixtures} fixtures${duplicateEvents ? ` (${duplicateEvents} duplicate source rows)` : ""}`);
console.table(bySource);
console.log(`oddsapi credits remaining: ${getMeta("oddsapi_credits_remaining") ?? "n/a"} (last call: ${getMeta("oddsapi_last_call") ?? "never"})`);
console.log(`sporttery last call: ${getMeta("sporttery_last_call") ?? "never"} (source updated: ${getMeta("sporttery_source_updated") ?? "n/a"})`);
if (next24h.length) {
  console.log(`\nnext 24h:`);
  for (const e of next24h) console.log(`  ${e.kickoff_utc}  ${e.m}`);
}
