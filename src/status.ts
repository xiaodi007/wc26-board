// 快速体检: 各源快照量 / 最新时间 / Odds API 配额余量
import { db, getMeta } from "./db.js";

const bySource = db
  .prepare(
    `SELECT m.source, COUNT(s.id) AS snaps, MAX(s.ts) AS latest, COUNT(DISTINCT o.id) AS outcomes
     FROM snapshot s JOIN outcome o ON o.id=s.outcome_id JOIN market m ON m.id=o.market_id
     GROUP BY m.source ORDER BY snaps DESC`
  )
  .all() as { source: string; snaps: number; latest: string; outcomes: number }[];

const events = (db.prepare(`SELECT COUNT(*) AS n FROM event`).get() as { n: number }).n;
const next24h = db
  .prepare(`SELECT home_team || ' vs ' || away_team AS m, kickoff_utc FROM event
            WHERE kickoff_utc BETWEEN datetime('now') AND datetime('now','+1 day') ORDER BY kickoff_utc`)
  .all() as { m: string; kickoff_utc: string }[];

console.log(`events: ${events}`);
console.table(bySource);
console.log(`oddsapi credits remaining: ${getMeta("oddsapi_credits_remaining") ?? "n/a"} (last call: ${getMeta("oddsapi_last_call") ?? "never"})`);
if (next24h.length) {
  console.log(`\nnext 24h:`);
  for (const e of next24h) console.log(`  ${e.kickoff_utc}  ${e.m}`);
}
