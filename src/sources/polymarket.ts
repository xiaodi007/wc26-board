import { fetchJson } from "../http.js";
import { GAMMA_BASE, PM_OUTRIGHT_SLUG, PM_OUTRIGHT_ID, log } from "../config.js";
import { upsertEvent, getOrCreateMarket, getOrCreateOutcome, insertSnapshots, type SnapshotRow } from "../db.js";
import { pmPriceToProb, parseStringArray } from "../normalize.js";
import { teamsMatch } from "../teams.js";

interface GammaMarket {
  id: string;
  question?: string;
  outcomes?: unknown; // JSON 字符串数组
  outcomePrices?: unknown; // JSON 字符串数组
  bestBid?: number;
  bestAsk?: number;
  liquidity?: string | number;
  volume24hr?: number;
  closed?: boolean;
  updatedAt?: string;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: GammaMarket[];
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
        const outcomeId = getOrCreateOutcome(marketId, cls.label);
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
    }
    if (page.length < PAGE_LIMIT) break;
  }

  const n = insertSnapshots(rows);
  log(
    `polymarket: games ${seen.size} events, ${n} snapshots, ${skipped} derivative markets skipped` +
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
