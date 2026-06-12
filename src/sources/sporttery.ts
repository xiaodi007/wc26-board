import { fetchJsonWithHeaders } from "../http.js";
import { fixtureKey, normalizeKickoffUtc } from "../fixtures.js";
import { decimalToProb } from "../normalize.js";
import { db, getOrCreateMarket, getOrCreateOutcome, insertSnapshots, setMeta, upsertEvent, type SnapshotRow } from "../db.js";
import { log } from "../config.js";

type SportteryPool = "had" | "hhad";
type Label = "home" | "draw" | "away";

interface SportteryOdds {
  h?: string;
  d?: string;
  a?: string;
  goalLine?: string;
  updateDate?: string;
  updateTime?: string;
}

interface SportteryMatch {
  matchId: number;
  matchNumStr?: string;
  matchDate: string;
  matchTime: string;
  homeTeamAllName: string;
  awayTeamAllName: string;
  homeTeamCode?: string;
  awayTeamCode?: string;
  homeTeamAbbEnName?: string;
  awayTeamAbbEnName?: string;
  leagueAllName?: string;
  had?: SportteryOdds;
  hhad?: SportteryOdds;
}

interface SportteryResponse {
  errorCode: string;
  errorMessage?: string;
  value?: {
    lastUpdateTime?: string;
    totalCount?: number;
    matchInfoList?: { businessDate: string; subMatchList: SportteryMatch[] }[];
  };
}

const SPORTTERY_URL =
  "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad%2Chad";

const REQUEST_HEADERS = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Origin: "https://www.sporttery.cn",
  Referer: "https://www.sporttery.cn/jc/jsq/zqspf/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

function kickoffUtc(match: SportteryMatch): string {
  const d = new Date(`${match.matchDate}T${match.matchTime}+08:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`sporttery: invalid kickoff ${match.matchDate} ${match.matchTime}`);
  return d.toISOString();
}

function sourceUpdatedTs(odds: SportteryOdds): string | null {
  if (!odds.updateDate || !odds.updateTime) return null;
  const d = new Date(`${odds.updateDate}T${odds.updateTime}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function decimal(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function findEventId(match: SportteryMatch, kickoff: string): string {
  const key = fixtureKey(match.homeTeamAllName, match.awayTeamAllName, kickoff);
  const existing = db
    .prepare(`SELECT id FROM event WHERE fixture_key=? ORDER BY CASE WHEN id LIKE 'pm-%' THEN 0 ELSE 1 END, id LIMIT 1`)
    .get(key) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = `sporttery-${match.matchId}`;
  upsertEvent(id, match.homeTeamAllName, match.awayTeamAllName, normalizeKickoffUtc(kickoff));
  return id;
}

function addPoolRows(rows: SnapshotRow[], match: SportteryMatch, eventId: string, pool: SportteryPool): number {
  const odds = match[pool];
  if (!odds) return 0;

  const prices: Record<Label, number | null> = {
    home: decimal(odds.h),
    draw: decimal(odds.d),
    away: decimal(odds.a),
  };
  if (!prices.home || !prices.draw || !prices.away) return 0;

  const marketId = getOrCreateMarket(
    "sporttery",
    `${match.matchId}:${pool}`,
    pool === "had" ? "sporttery_had" : "sporttery_hhad",
    eventId,
    pool === "hhad" ? odds.goalLine ?? null : "had"
  );
  const sourceUpdated = sourceUpdatedTs(odds);
  for (const [label, sp] of Object.entries(prices) as [Label, number][]) {
    const outcomeId = getOrCreateOutcome(marketId, label);
    rows.push({
      outcomeId,
      rawPrice: JSON.stringify({
        sp,
        pool,
        goal_line: pool === "hhad" ? odds.goalLine ?? null : null,
        match_id: match.matchId,
        match_num: match.matchNumStr ?? null,
        home_code: match.homeTeamCode ?? match.homeTeamAbbEnName ?? null,
        away_code: match.awayTeamCode ?? match.awayTeamAbbEnName ?? null,
      }),
      probImplied: decimalToProb(sp),
      sourceUpdatedTs: sourceUpdated,
    });
  }
  return 3;
}

export async function pollSporttery(): Promise<number> {
  const { data } = await fetchJsonWithHeaders<SportteryResponse>(
    SPORTTERY_URL,
    "sporttery/getMatchCalculatorV1",
    REQUEST_HEADERS
  );
  if (data.errorCode !== "0" || !data.value?.matchInfoList) {
    throw new Error(`sporttery: API error ${data.errorCode} ${data.errorMessage ?? ""}`.trim());
  }

  const rows: SnapshotRow[] = [];
  let matches = 0;
  let hadMarkets = 0;
  let hhadMarkets = 0;
  for (const group of data.value.matchInfoList) {
    for (const match of group.subMatchList ?? []) {
      matches++;
      const kickoff = kickoffUtc(match);
      const eventId = findEventId(match, kickoff);
      if (addPoolRows(rows, match, eventId, "had")) hadMarkets++;
      if (addPoolRows(rows, match, eventId, "hhad")) hhadMarkets++;
    }
  }

  const n = insertSnapshots(rows);
  setMeta("sporttery_last_call", new Date().toISOString());
  if (data.value.lastUpdateTime) setMeta("sporttery_source_updated", data.value.lastUpdateTime);
  log(`sporttery: ${matches} matches, had=${hadMarkets}, hhad=${hhadMarkets}, ${n} snapshots`);
  return n;
}
