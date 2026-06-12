import { fetchJson } from "../http.js";
import { KALSHI_BASE, KALSHI_GAME_SERIES, KALSHI_OUTRIGHT_EVENT, log } from "../config.js";
import { db, getOrCreateMarket, getOrCreateOutcome, insertSnapshots, setMeta, type SnapshotRow } from "../db.js";
import { teamsMatch } from "../teams.js";

// 实测备注(2026-06-12 探明):
// - 冠军盘: event KXMENWORLDCUP-26(series KXMENWORLDCUP),48 个二元市场,yes_sub_title=队名。
//   注意另有空壳 series KXMWORLDCUP(0 events/markets),不要用;series 查 events 对冠军盘返回空,
//   必须直接 GET /events/{ticker}。
// - 单场盘: series KXWCGAME,每场一个 event(如 KXWCGAME-26JUN13BRAMAR),3 个市场:两队 + TIE,
//   yes_sub_title 为队名英文/"Tie"。event title "Home vs Away",与官方主客顺序一致。
// - API 不给精确开球时间(occurrence_datetime 是结算期望时间,非 kickoff),ticker 内日期是赛日。
//   因此不造 event,按队名归一 + 赛日±1 天挂到现有 fixture(PM/OddsAPI 已全覆盖),匹配不上记日志跳过。
// - 价格字段已迁移为 *_dollars 字符串(response_price_units=usd_cent),旧整数 cent 字段不再返回。
//   last_price_dollars 直接当隐含概率;远期无成交盘 last 缺失时退回 yes bid/ask 中点,仍缺则跳过。
// - 三个二元价加总 ≈1.02(overround),与 PM 同口径,三向归一放读取层。

interface KalshiMarket {
  ticker: string;
  status?: string;
  yes_sub_title?: string;
  last_price_dollars?: string | null;
  yes_bid_dollars?: string | null;
  yes_ask_dollars?: string | null;
  volume_24h_fp?: string | null;
  updated_time?: string | null;
}

interface KalshiEvent {
  event_ticker: string;
  title?: string;
  markets?: KalshiMarket[];
}

function num(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function impliedProb(m: KalshiMarket): number | null {
  const last = num(m.last_price_dollars);
  if (last !== null && last > 0 && last < 1) return last;
  const bid = num(m.yes_bid_dollars);
  const ask = num(m.yes_ask_dollars);
  if (bid !== null && ask !== null && bid > 0 && ask < 1 && bid <= ask) return (bid + ask) / 2;
  return null;
}

function snapshotRow(m: KalshiMarket, outcomeId: number, prob: number): SnapshotRow {
  return {
    outcomeId,
    rawPrice: JSON.stringify({
      last: m.last_price_dollars ?? null,
      yes_bid: m.yes_bid_dollars ?? null,
      yes_ask: m.yes_ask_dollars ?? null,
    }),
    probImplied: prob,
    bid: num(m.yes_bid_dollars),
    ask: num(m.yes_ask_dollars),
    volume: num(m.volume_24h_fp),
    sourceUpdatedTs: m.updated_time ?? null,
  };
}

// 冠军盘: 48 个 "Will X win?" 二元,yes 价即夺冠隐含概率
export async function pollKalshiOutright(): Promise<number> {
  const data = await fetchJson<{ event?: KalshiEvent }>(
    `${KALSHI_BASE}/events/${KALSHI_OUTRIGHT_EVENT}?with_nested_markets=true`,
    "kalshi/outright"
  );
  const rows: SnapshotRow[] = [];
  for (const m of data.event?.markets ?? []) {
    if ((m.status && m.status !== "active") || !m.yes_sub_title) continue;
    const prob = impliedProb(m);
    if (prob === null) continue;
    const marketId = getOrCreateMarket("kalshi", m.ticker, "outright_winner", null, KALSHI_OUTRIGHT_EVENT);
    rows.push(snapshotRow(m, getOrCreateOutcome(marketId, m.yes_sub_title), prob));
  }
  const n = insertSnapshots(rows);
  setMeta("kalshi_last_call", new Date().toISOString());
  log(`kalshi: outright ${n} snapshots`);
  return n;
}

// "26JUN13" → 2026-06-13(ticker 内赛日,无时分)
const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};
function tickerDate(eventTicker: string): string | null {
  const m = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})[A-Z]/);
  if (!m || !MONTHS[m[2]]) return null;
  return `20${m[1]}-${MONTHS[m[2]]}-${m[3]}`;
}

interface DbEvent {
  id: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
}

// Kalshi 拿不到 kickoff,不能算 fixture_key;按队名对 + 赛日±1 天找现有 event(优先 pm-,同 sporttery)
function findEventId(events: DbEvent[], home: string, away: string, date: string | null): string | null {
  const dateMs = date ? Date.parse(`${date}T12:00:00Z`) : NaN;
  let fallback: string | null = null;
  for (const ev of events) {
    if (!teamsMatch(home, ev.home_team) || !teamsMatch(away, ev.away_team)) continue;
    if (!Number.isNaN(dateMs)) {
      const kickoffMs = Date.parse(ev.kickoff_utc);
      if (!Number.isNaN(kickoffMs) && Math.abs(kickoffMs - dateMs) > 36 * 3600 * 1000) continue;
    }
    if (ev.id.startsWith("pm-")) return ev.id;
    fallback = fallback ?? ev.id;
  }
  return fallback;
}

export async function pollKalshiMatches(): Promise<number> {
  const dbEvents = db
    .prepare(`SELECT id, home_team, away_team, kickoff_utc FROM event`)
    .all() as DbEvent[];

  const rows: SnapshotRow[] = [];
  const matched = new Set<string>();
  let unmatched = 0;
  let noPrice = 0;
  let cursor = "";

  for (let page = 0; page < 10; page++) {
    const url =
      `${KALSHI_BASE}/events?series_ticker=${KALSHI_GAME_SERIES}&status=open&limit=200&with_nested_markets=true` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = await fetchJson<{ events?: KalshiEvent[]; cursor?: string }>(url, `kalshi/games page=${page}`);
    const events = data.events ?? [];

    for (const ev of events) {
      const [home, away] = (ev.title ?? "").split(/\s+vs\.?\s+/i);
      if (!home || !away) continue;
      const eventId = findEventId(dbEvents, home, away, tickerDate(ev.event_ticker));
      if (!eventId) {
        unmatched++;
        log(`kalshi: UNMATCHED game: ${ev.event_ticker} "${ev.title}"`);
        continue;
      }
      matched.add(ev.event_ticker);

      for (const m of ev.markets ?? []) {
        if ((m.status && m.status !== "active") || !m.yes_sub_title) continue;
        const cls = classifyGameMarket(m.yes_sub_title, home, away);
        if (!cls) {
          log(`kalshi: ALIAS GAP: "${m.yes_sub_title}" not in {${home}, ${away}}`);
          continue;
        }
        const prob = impliedProb(m);
        if (prob === null) {
          noPrice++; // 远期盘还没有报价,正常现象
          continue;
        }
        const marketId = getOrCreateMarket("kalshi", m.ticker, cls.type, eventId, ev.event_ticker);
        rows.push(snapshotRow(m, getOrCreateOutcome(marketId, cls.label), prob));
      }
    }

    cursor = data.cursor ?? "";
    if (!cursor || events.length === 0) break;
  }

  const n = insertSnapshots(rows);
  setMeta("kalshi_last_call", new Date().toISOString());
  log(
    `kalshi: games ${matched.size} events, ${n} snapshots, ${noPrice} markets without quotes` +
      (unmatched ? `, ${unmatched} UNMATCHED` : "")
  );
  return n;
}

function classifyGameMarket(yesSubTitle: string, home: string, away: string): { type: string; label: string } | null {
  if (/^tie$/i.test(yesSubTitle.trim())) return { type: "draw_binary", label: "draw" };
  if (teamsMatch(yesSubTitle, home)) return { type: "home_win_binary", label: "home" };
  if (teamsMatch(yesSubTitle, away)) return { type: "away_win_binary", label: "away" };
  return null;
}
