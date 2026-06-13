import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = join(ROOT, "data");
export const LOG_DIR = join(ROOT, "logs");
export const DB_PATH = join(DATA_DIR, "wc26.db");

for (const d of [DATA_DIR, LOG_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// .env loader (项目根目录,KEY=VALUE 行;不引第三方依赖)
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

export const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

// 轮询间隔。Odds API 免费层 500 credits/月:h2h×eu = 1 credit/次,90min ≈ 480/月,贴着配额顶跑
export const PM_POLL_MS = Number(process.env.PM_POLL_MS || 5 * 60 * 1000);
export const ODDSAPI_POLL_MS = Number(process.env.ODDSAPI_POLL_MS || 90 * 60 * 1000);

export const ODDSAPI_BASE = "https://api.the-odds-api.com/v4";
export const ODDSAPI_SPORT = "soccer_fifa_world_cup";
export const ODDSAPI_REGIONS = process.env.ODDSAPI_REGIONS || "eu";
export const ODDSAPI_MARKETS = process.env.ODDSAPI_MARKETS || "h2h";

export const GAMMA_BASE = "https://gamma-api.polymarket.com";
export const PM_DATA_BASE = process.env.PM_DATA_BASE || "https://data-api.polymarket.com";
export const PM_OUTRIGHT_SLUG = "world-cup-winner";
export const PM_OUTRIGHT_ID = "30615"; // slug 查询偶发空响应时的兜底
export const PM_PARTICIPATION_MAX_MARKETS = Number(process.env.PM_PARTICIPATION_MAX_MARKETS || 90);
export const PM_PARTICIPATION_BATCH_SIZE = Number(process.env.PM_PARTICIPATION_BATCH_SIZE || 10);
export const PM_PARTICIPATION_TRADE_LIMIT = Number(process.env.PM_PARTICIPATION_TRADE_LIMIT || 10000);
export const PM_PARTICIPATION_HOLDER_LIMIT = Number(process.env.PM_PARTICIPATION_HOLDER_LIMIT || 20);
export const PM_PARTICIPATION_LOOKBACK_HOURS = Number(process.env.PM_PARTICIPATION_LOOKBACK_HOURS || 24);

// Kalshi 公开行情 API,行情读取无需鉴权
export const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_OUTRIGHT_EVENT = "KXMENWORLDCUP-26"; // 2026 Men's World Cup Winner(48 队二元)
export const KALSHI_GAME_SERIES = "KXWCGAME"; // 单场系列,每场 3 个二元市场(两队 + TIE)
export const KALSHI_POLL_MS = Number(process.env.KALSHI_POLL_MS || 5 * 60 * 1000);

// 本地只读 board,只绑 127.0.0.1。PORT 兜底兼容 IDE preview 注入的端口
export const BOARD_PORT_EXPLICIT = Boolean(process.env.BOARD_PORT || process.env.PORT);
export const BOARD_PORT = Number(process.env.BOARD_PORT || process.env.PORT || 4626);

// Walrus public data feed export/publish. V1 only publishes sanitized aggregate snapshots.
const walrusFeedDirRaw = process.env.WALRUS_FEED_DIR || "data/walrus-feed";
export const WALRUS_ENABLED = (process.env.WALRUS_ENABLED || "false").toLowerCase() === "true";
export const WALRUS_NETWORK = process.env.WALRUS_NETWORK || "testnet";
export const WALRUS_EPOCHS = Number(process.env.WALRUS_EPOCHS || 3);
export const WALRUS_PUBLISHER_URL = process.env.WALRUS_PUBLISHER_URL || "";
export const WALRUS_FEED_DIR = isAbsolute(walrusFeedDirRaw) ? walrusFeedDirRaw : join(ROOT, walrusFeedDirRaw);

// AI 分析面板。无 key 时面板降级为 prompt 预览 + 复制(粘贴到任意 AI 用)
export const AI_PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
export const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 4000);
export const AI_THINKING = process.env.AI_THINKING || "off";
export const AI_TEMPERATURE = process.env.AI_TEMPERATURE || "";

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
export const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
export const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_CHAT_MODEL || "deepseek-v4-flash";
export const DEEPSEEK_THINKING_MODEL = process.env.DEEPSEEK_THINKING_MODEL || process.env.DEEPSEEK_REASONER_MODEL || "deepseek-v4-pro";
export const DEEPSEEK_THINKING = process.env.DEEPSEEK_THINKING || AI_THINKING;
export const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "high";
export const DEEPSEEK_TEMPERATURE = process.env.DEEPSEEK_TEMPERATURE || AI_TEMPERATURE || "0.35";

export const KIMI_API_KEY = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "";
export const KIMI_BASE = process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1";
export const KIMI_MODEL = process.env.KIMI_CHAT_MODEL || "kimi-k2.6";
export const KIMI_THINKING = process.env.KIMI_THINKING || AI_THINKING;
export const KIMI_TEMPERATURE = process.env.KIMI_DEFAULT_TEMPERATURE || process.env.KIMI_TEMPERATURE || AI_TEMPERATURE || "1";

export const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OPENAI_API_KEY || "";
export const OPENAI_COMPAT_BASE = process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENAI_BASE_URL || "";
export const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || process.env.OPENAI_MODEL || "";

// 告警:Server酱微信推送。免费版每日配额很小(约 5 条),所有新事件合并成一条推,另设日上限兜底。
// key 为空时只落 alert_log 不推送(页面仍可见)。
export const SERVERCHAN_KEY = process.env.SERVERCHAN_KEY || "";
export const ALERT_JUMP_PP = Number(process.env.ALERT_JUMP_PP || 3);
export const ALERT_MAX_PER_DAY = Number(process.env.ALERT_MAX_PER_DAY || 5);

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
