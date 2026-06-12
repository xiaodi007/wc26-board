import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
export const PM_OUTRIGHT_SLUG = "world-cup-winner";
export const PM_OUTRIGHT_ID = "30615"; // slug 查询偶发空响应时的兜底

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
