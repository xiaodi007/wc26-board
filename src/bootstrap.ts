// 一次性初始化:建库 + 赛程导入 + 首轮快照。可重复执行(幂等)。
import { db } from "./db.js";
import { ODDS_API_KEY, log } from "./config.js";
import { bootstrapEvents, pollOdds } from "./sources/oddsapi.js";
import { pollOutright } from "./sources/polymarket.js";

log("bootstrap: db schema ready");

if (ODDS_API_KEY) {
  await bootstrapEvents();
  await pollOdds();
} else {
  log("bootstrap: ODDS_API_KEY 未设置 — 跳过书商盘。去 https://the-odds-api.com/ 免费注册,key 写进 .env 后重跑本脚本");
}

await pollOutright();

const counts = db
  .prepare(
    `SELECT m.source, COUNT(s.id) AS snaps FROM snapshot s JOIN outcome o ON o.id=s.outcome_id JOIN market m ON m.id=o.market_id GROUP BY m.source`
  )
  .all() as { source: string; snaps: number }[];
const events = (db.prepare(`SELECT COUNT(*) AS n FROM event`).get() as { n: number }).n;
log(`bootstrap done. events=${events}, snapshots: ${counts.map((c) => `${c.source}=${c.snaps}`).join(", ") || "(none)"}`);
