// 单轮采集(测试/手动用)。常驻采集请用 daemon.ts。
// 每个源独立 try/catch:单源故障(大陆链路抖动是常态)不拖垮整轮。
import { log } from "./config.js";
import { pollOdds } from "./sources/oddsapi.js";
import { pollOutright, pollMatchGames } from "./sources/polymarket.js";

const results: string[] = [];
for (const [name, fn] of [
  ["polymarket/outright", pollOutright],
  ["polymarket/games", pollMatchGames],
  ["oddsapi/h2h", pollOdds],
] as const) {
  try {
    const n = await fn();
    results.push(`${name}=${n}`);
  } catch (e) {
    results.push(`${name}=ERR`);
    log(`poll: ${name} failed: ${String(e)}`);
  }
}
log(`poll cycle done: ${results.join(" ")}`);
