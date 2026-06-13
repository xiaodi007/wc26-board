// 常驻采集进程(launchd KeepAlive 拉起)。
// 节奏: PM 免费源高频(默认 5min);The Odds API 按配额低频(免费层默认 90min)。
// 配额硬保护: 距上次调用不足间隔的 80% 绝不发请求(deepseek 翻车点 #3)。
import { PM_POLL_MS, ODDSAPI_POLL_MS, KALSHI_POLL_MS, ODDS_API_KEY, WALRUS_ENABLED, WALRUS_PUBLISHER_URL, log } from "./config.js";
import { getMeta, setMeta } from "./db.js";
import { pollOdds } from "./sources/oddsapi.js";
import { pollOutright, pollMatchGames } from "./sources/polymarket.js";
import { pollKalshiOutright, pollKalshiMatches } from "./sources/kalshi.js";
import { checkAlerts } from "./alerts.js";
import { publishWalrusSnapshot } from "./publishWalrus.js";

const TICK_MS = 60_000;
let lastPm = 0;
let lastKalshi = 0;

log(`daemon start: PM every ${PM_POLL_MS / 60000}min, Kalshi every ${KALSHI_POLL_MS / 60000}min, OddsAPI every ${ODDSAPI_POLL_MS / 60000}min${ODDS_API_KEY ? "" : " (no key — PM only)"}`);

async function tick(): Promise<void> {
  const now = Date.now();
  let collected = false;

  if (now - lastPm >= PM_POLL_MS) {
    lastPm = now;
    try {
      await pollOutright();
      await pollMatchGames();
      collected = true;
    } catch (e) {
      log(`daemon: polymarket cycle failed: ${String(e)}`);
    }
  }

  if (now - lastKalshi >= KALSHI_POLL_MS) {
    lastKalshi = now;
    try {
      await pollKalshiOutright();
      await pollKalshiMatches();
      collected = true;
    } catch (e) {
      log(`daemon: kalshi cycle failed: ${String(e)}`);
    }
  }

  if (ODDS_API_KEY) {
    const last = Date.parse(getMeta("oddsapi_last_call") ?? "0") || 0;
    if (now - last >= ODDSAPI_POLL_MS * 0.8) {
      try {
        await pollOdds();
        collected = true;
      } catch (e) {
        log(`daemon: oddsapi cycle failed: ${String(e)}`);
      }
    }
  }

  try {
    await checkAlerts();
  } catch (e) {
    log(`daemon: alerts failed: ${String(e)}`);
  }

  if (collected && WALRUS_ENABLED) {
    try {
      if (!WALRUS_PUBLISHER_URL) {
        setMeta("walrus_latest_error", "WALRUS_PUBLISHER_URL is required for daemon compact publish");
        throw new Error("WALRUS_PUBLISHER_URL is required for daemon compact publish");
      }
      const result = await publishWalrusSnapshot({ compact: true });
      log(`daemon: walrus compact publish manifest=${result.manifestBlobId} artifacts=${result.artifactCount}`);
    } catch (e) {
      log(`daemon: walrus compact publish failed: ${String(e)}`);
    }
  }
}

await tick();
setInterval(() => void tick().catch((e) => log(`daemon tick error: ${String(e)}`)), TICK_MS);
