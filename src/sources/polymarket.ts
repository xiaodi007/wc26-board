import { fetchJson } from "../http.js";
import {
  GAMMA_BASE,
  PM_DATA_BASE,
  PM_OUTRIGHT_SLUG,
  PM_OUTRIGHT_ID,
  PM_PARTICIPATION_BATCH_SIZE,
  PM_PARTICIPATION_HOLDER_LIMIT,
  PM_PARTICIPATION_LOOKBACK_HOURS,
  PM_PARTICIPATION_MAX_MARKETS,
  PM_PARTICIPATION_TRADE_LIMIT,
  log,
} from "../config.js";
import {
  upsertEvent,
  getOrCreateMarket,
  getOrCreateOutcome,
  insertMarketMetricSnapshots,
  insertSnapshots,
  setMarketConditionId,
  type MarketMetricSnapshotRow,
  type SnapshotRow,
} from "../db.js";
import { pmPriceToProb, parseStringArray } from "../normalize.js";
import { teamsMatch } from "../teams.js";

interface GammaMarket {
  id: string;
  question?: string;
  outcomes?: unknown; // JSON 字符串数组
  outcomePrices?: unknown; // JSON 字符串数组
  conditionId?: string;
  clobTokenIds?: unknown;
  bestBid?: number;
  bestAsk?: number;
  liquidity?: string | number;
  liquidityNum?: number;
  liquidityClob?: number;
  volume?: string | number;
  volumeNum?: number;
  volume24hr?: number;
  volume24hrClob?: number;
  spread?: number;
  lastTradePrice?: number;
  closed?: boolean;
  updatedAt?: string;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: GammaMarket[];
}

interface HolderRow {
  proxyWallet?: string;
  amount?: number;
}

interface HolderTokenRow {
  token?: string;
  holders?: HolderRow[];
}

interface TradeRow {
  proxyWallet?: string;
  user?: string;
  conditionId?: string;
  timestamp?: number;
}

interface ParticipationStats {
  holderDepthTop: number | null;
  holderConcentration: number | null;
  activeTraders24h: number | null;
  tradeCount24h: number | null;
  holdersSampled: boolean;
  tradesSampled: boolean;
}

interface MetricWorkItem extends MarketMetricSnapshotRow {
  conditionId: string;
  tokenIds: string[];
  sortSignal: number;
}

function num(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function fetchOutrightEvent(): Promise<GammaEvent | null> {
  // slug 查询偶发空数组(链路抖动),双路兜底到固定 id
  try {
    const bySlug = await fetchJson<GammaEvent[]>(
      `${GAMMA_BASE}/events?slug=${PM_OUTRIGHT_SLUG}`,
      "gamma/events?slug"
    );
    if (Array.isArray(bySlug) && bySlug.length > 0) return bySlug[0];
  } catch {
    /* fallthrough */
  }
  try {
    return await fetchJson<GammaEvent>(`${GAMMA_BASE}/events/${PM_OUTRIGHT_ID}`, "gamma/events/id");
  } catch (e) {
    log(`polymarket: outright fetch failed: ${String(e)}`);
    return null;
  }
}

// 冠军盘: 60 个 "Will X win the 2026 FIFA World Cup?" Yes/No 二元市场
export async function pollOutright(): Promise<number> {
  const event = await fetchOutrightEvent();
  if (!event) return 0;

  const rows: SnapshotRow[] = [];
  let unmatched = 0;
  for (const m of event.markets ?? []) {
    if (m.closed) continue;
    const team = m.question?.match(/^Will (.+?) win the 2026 FIFA World Cup/i)?.[1];
    if (!team) {
      unmatched++;
      log(`polymarket: UNMATCHED outright question: ${m.question ?? m.id}`);
      continue;
    }
    const prices = parseStringArray(m.outcomePrices);
    const yesPrice = Number(prices[0]);
    const marketId = getOrCreateMarket("polymarket", m.id, "outright_winner", null, "world-cup-winner");
    const outcomeId = getOrCreateOutcome(marketId, team);
    rows.push({
      outcomeId,
      rawPrice: JSON.stringify({ yes: prices[0], no: prices[1] }),
      probImplied: pmPriceToProb(yesPrice),
      bid: m.bestBid ?? null,
      ask: m.bestAsk ?? null,
      volume: m.volume24hr ?? null,
      sourceUpdatedTs: m.updatedAt ?? null,
    });
  }
  const n = insertSnapshots(rows);
  log(`polymarket: outright ${n} snapshots${unmatched ? ` (${unmatched} unmatched)` : ""}`);
  return n;
}

// 单场比赛盘。实测结构(2026-06-12 探明):
//   series soccer-fifwc (id=11433) 下每场一个 event,ticker 'fifwc-{home}-{away}-{date}',
//   含 3 个 moneyline 二元市场:主胜 / 客胜 / "end in a draw",Yes 价即概率。
//   三者加总通常 ≠1(独立交易),三向归一在读取层做(任一缺失则放弃三向,deepseek 陷阱)。
const PM_SERIES_ID = "11433";
const PAGE_LIMIT = 20; // 完整 event 对象很重,大分页在大陆链路上会超时截断
const MAIN_TICKER = /^fifwc-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/;

export async function pollMatchGames(): Promise<number> {
  const rows: SnapshotRow[] = [];
  const metrics: MetricWorkItem[] = [];
  const seen = new Set<string>(); // 分页期间列表会动,跨页去重
  let skipped = 0;
  const skippedSamples: string[] = [];

  for (let offset = 0; offset < 600; offset += PAGE_LIMIT) {
    const page = await fetchJson<GammaMatchEvent[]>(
      `${GAMMA_BASE}/events?series_id=${PM_SERIES_ID}&closed=false&limit=${PAGE_LIMIT}&offset=${offset}`,
      `gamma/series offset=${offset}`
    );
    if (!Array.isArray(page) || page.length === 0) break;

    for (const ev of page) {
      // 主事件 ticker 形如 fifwc-usa-par-2026-06-12;带后缀的是子事件(Player Props/
      // Halftime Result/Exact Score 等),跳过以免污染 event 表
      if (!ev.ticker || !MAIN_TICKER.test(ev.ticker) || seen.has(ev.id)) continue;
      seen.add(ev.id);
      const [home, away] = (ev.title ?? "").split(/\s+vs\.?\s+/i);
      if (!home || !away) continue; // 非对阵类事件(占位/特殊盘)
      const kickoff = toIso(ev.markets?.[0]?.gameStartTime) ?? ev.endDate ?? "";
      upsertEvent(`pm-${ev.id}`, home, away, kickoff);

      for (const m of ev.markets ?? []) {
        if (m.closed) continue;
        const cls = classifyMatchMarket(m.question ?? "", home, away);
        if (!cls) {
          // Phase A 只采全场主三元;半场/角球等衍生盘静默跳过,只留样本便于日后扩展
          skipped++;
          if (skippedSamples.length < 3 && m.question) skippedSamples.push(m.question);
          continue;
        }
        const prices = parseStringArray(m.outcomePrices);
        const yesPrice = Number(prices[0]);
        const marketId = getOrCreateMarket("polymarket", m.id, cls.type, `pm-${ev.id}`, ev.ticker);
        setMarketConditionId(marketId, m.conditionId);
        const outcomeId = getOrCreateOutcome(marketId, cls.label);
        rows.push({
          outcomeId,
          rawPrice: JSON.stringify({ yes: prices[0], no: prices[1], conditionId: m.conditionId ?? null }),
          probImplied: pmPriceToProb(yesPrice),
          bid: m.bestBid ?? null,
          ask: m.bestAsk ?? null,
          volume: m.volume24hr ?? null,
          sourceUpdatedTs: m.updatedAt ?? null,
        });
        const metric = metricFromGamma(marketId, m);
        if (metric) metrics.push(metric);
      }
    }
    if (page.length < PAGE_LIMIT) break;
  }

  await enrichParticipation(metrics);
  const n = insertSnapshots(rows);
  const metricN = insertMarketMetricSnapshots(metrics);
  log(
    `polymarket: games ${seen.size} events, ${n} snapshots, ${metricN} metric snapshots, ${skipped} derivative markets skipped` +
      (skippedSamples.length ? ` (e.g. ${skippedSamples.join(" | ")})` : "")
  );
  return n;
}

interface GammaMatchEvent {
  id: string;
  ticker?: string;
  title?: string;
  endDate?: string;
  markets?: (GammaMarket & { gameStartTime?: string })[];
}

// "2026-06-13 01:00:00+00" → ISO 8601
function toIso(raw?: string): string | null {
  if (!raw) return null;
  const d = new Date(raw.replace(" ", "T").replace(/\+00$/, "Z"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function batch<T>(items: T[], size: number): T[][] {
  const safeSize = Number.isInteger(size) && size > 0 ? Math.min(size, 50) : 10;
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) result.push(items.slice(i, i + safeSize));
  return result;
}

function metricFromGamma(marketId: number, m: GammaMarket): MetricWorkItem | null {
  if (!m.conditionId) return null;
  const bestBid = num(m.bestBid);
  const bestAsk = num(m.bestAsk);
  const liquidityClob = num(m.liquidityClob);
  const liquidity = liquidityClob ?? num(m.liquidityNum) ?? num(m.liquidity);
  const volume24h = num(m.volume24hrClob) ?? num(m.volume24hr);
  const volumeTotal = num(m.volumeNum) ?? num(m.volume);
  const spread = num(m.spread) ?? (bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null);
  return {
    marketId,
    source: "polymarket",
    sourceMarketId: m.id,
    conditionId: m.conditionId,
    liquidity,
    liquidityClob,
    volume24h,
    volumeTotal,
    spread,
    bestBid,
    bestAsk,
    lastTradePrice: num(m.lastTradePrice),
    sourceUpdatedTs: m.updatedAt ?? null,
    tokenIds: parseStringArray(m.clobTokenIds),
    sortSignal: (volume24h ?? 0) + (liquidity ?? 0) * 0.05,
  };
}

async function fetchHolderStats(
  items: MetricWorkItem[]
): Promise<Map<string, Pick<ParticipationStats, "holderDepthTop" | "holderConcentration" | "holdersSampled">>> {
  const byToken = new Map<string, string>();
  for (const item of items) {
    for (const token of item.tokenIds) byToken.set(token, item.conditionId);
  }

  const out = new Map<string, Pick<ParticipationStats, "holderDepthTop" | "holderConcentration" | "holdersSampled">>();
  if (items.length === 0) return out;

  const limit = Math.min(Math.max(PM_PARTICIPATION_HOLDER_LIMIT || 20, 1), 20);
  for (const group of batch(items, PM_PARTICIPATION_BATCH_SIZE)) {
    const ids = group.map((i) => i.conditionId).join(",");
    const url = `${PM_DATA_BASE}/holders?limit=${limit}&market=${encodeURIComponent(ids)}`;
    const rows = await fetchJson<HolderTokenRow[]>(url, "polymarket/data holders");

    const wallets = new Map<string, Set<string>>();
    const totals = new Map<string, { max: number; sum: number; sampled: boolean }>();
    for (const tokenRow of rows ?? []) {
      const conditionId = tokenRow.token ? byToken.get(tokenRow.token) : null;
      if (!conditionId) continue;
      const walletSet = wallets.get(conditionId) ?? new Set<string>();
      const acc = totals.get(conditionId) ?? { max: 0, sum: 0, sampled: false };
      const holders = tokenRow.holders ?? [];
      if (holders.length >= limit) acc.sampled = true;
      for (const holder of holders) {
        if (holder.proxyWallet) walletSet.add(holder.proxyWallet);
        const amount = num(holder.amount) ?? 0;
        acc.sum += amount;
        acc.max = Math.max(acc.max, amount);
      }
      wallets.set(conditionId, walletSet);
      totals.set(conditionId, acc);
    }

    for (const item of group) {
      const walletSet = wallets.get(item.conditionId);
      const acc = totals.get(item.conditionId);
      out.set(item.conditionId, {
        holderDepthTop: walletSet ? walletSet.size : 0,
        holderConcentration: acc && acc.sum > 0 ? acc.max / acc.sum : null,
        holdersSampled: acc?.sampled ?? false,
      });
    }
  }
  return out;
}

async function fetchTradeStats(
  items: MetricWorkItem[]
): Promise<Map<string, Pick<ParticipationStats, "activeTraders24h" | "tradeCount24h" | "tradesSampled">>> {
  const out = new Map<string, Pick<ParticipationStats, "activeTraders24h" | "tradeCount24h" | "tradesSampled">>();
  if (items.length === 0) return out;

  const limit = Math.min(Math.max(PM_PARTICIPATION_TRADE_LIMIT || 10000, 1), 10000);
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(PM_PARTICIPATION_LOOKBACK_HOURS || 24, 1) * 3600;
  for (const group of batch(items, PM_PARTICIPATION_BATCH_SIZE)) {
    const ids = group.map((i) => i.conditionId).join(",");
    const url = `${PM_DATA_BASE}/trades?limit=${limit}&offset=0&takerOnly=true&market=${encodeURIComponent(ids)}`;
    const rows = await fetchJson<TradeRow[]>(url, "polymarket/data trades");

    const wallets = new Map<string, Set<string>>();
    const counts = new Map<string, number>();
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const trade of rows ?? []) {
      const conditionId = trade.conditionId;
      if (!conditionId) continue;
      const ts = num(trade.timestamp);
      if (ts !== null) oldestTs = Math.min(oldestTs, ts);
      if (ts === null || ts < cutoff) continue;
      const wallet = trade.proxyWallet ?? trade.user;
      if (wallet) {
        const set = wallets.get(conditionId) ?? new Set<string>();
        set.add(wallet);
        wallets.set(conditionId, set);
      }
      counts.set(conditionId, (counts.get(conditionId) ?? 0) + 1);
    }
    const sampled = rows.length >= limit && oldestTs >= cutoff;

    for (const item of group) {
      out.set(item.conditionId, {
        activeTraders24h: wallets.get(item.conditionId)?.size ?? 0,
        tradeCount24h: counts.get(item.conditionId) ?? 0,
        tradesSampled: sampled,
      });
    }
  }
  return out;
}

async function enrichParticipation(metrics: MetricWorkItem[]): Promise<void> {
  const maxMarkets = Math.max(0, PM_PARTICIPATION_MAX_MARKETS || 0);
  if (maxMarkets === 0) return;
  const selected = [...metrics]
    .filter((m) => m.conditionId && m.tokenIds.length > 0)
    .sort((a, b) => b.sortSignal - a.sortSignal)
    .slice(0, maxMarkets);
  if (!selected.length) return;

  try {
    const holderStats = await fetchHolderStats(selected);
    for (const metric of selected) Object.assign(metric, holderStats.get(metric.conditionId));
  } catch (e) {
    log(`polymarket: holders enrichment failed: ${String(e)}`);
  }

  try {
    const tradeStats = await fetchTradeStats(selected);
    for (const metric of selected) Object.assign(metric, tradeStats.get(metric.conditionId));
  } catch (e) {
    log(`polymarket: trades enrichment failed: ${String(e)}`);
  }
}

function classifyMatchMarket(
  question: string,
  home: string,
  away: string
): { type: string; label: string } | null {
  if (/end in a draw/i.test(question)) return { type: "draw_binary", label: "draw" };
  const team = question.match(/^Will (.+?) win on \d{4}-\d{2}-\d{2}/i)?.[1];
  if (!team) return null;
  if (teamsMatch(team, home)) return { type: "home_win_binary", label: "home" };
  if (teamsMatch(team, away)) return { type: "away_win_binary", label: "away" };
  // 队名对不上主客任一方:别名表缺口。保留数据,打日志补别名。
  log(`polymarket: ALIAS GAP: "${team}" not in {${home}, ${away}}`);
  return { type: "win_binary", label: team };
}
