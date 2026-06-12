// 单场比赛 → AI 输入的数据组装。原则:
//   - 全部预计算(归一概率、价差 pp、走势关键点),不让模型自己做算术;
//   - 关键点采样而非原始快照(开盘/24h前/6h前/当前 + 突变点),单场 ~1k tokens;
//   - 标注口径(归一、中位、抽水),模型只负责解读不负责清洗。
import { getCurrentOdds, LABELS, type CurrentOddsRow, type Label, type ThreeWay } from "../queries/currentOdds.js";
import { getLineHistory, type SourceLineHistory } from "../queries/lineHistory.js";
import { getOutrightBoard } from "../queries/outright.js";
import { getSportteryHhad } from "../queries/hhad.js";
import { fmtAge, getSourceFreshness } from "../queries/healthChecks.js";
import { teamsMatch, zhTeamName } from "../teams.js";

const LABEL_ZH: Record<Label, string> = { home: "主胜", draw: "平", away: "客胜" };

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`;
}

function pp(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
}

function threeWayLine(probs: ThreeWay | null): string {
  if (!probs) return "-";
  return LABELS.map((l) => pct(probs[l])).join(" / ");
}

function diffLine(a: ThreeWay, b: ThreeWay): string {
  return LABELS.map((l) => `${LABEL_ZH[l]} ${pp((a[l] - b[l]) * 100)}`).join(", ");
}

const bjFull = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface TrendKeyPoints {
  source: string;
  label: Label;
  earliest: { ts: string; v: number } | null;
  h24: { ts: string; v: number } | null;
  h6: { ts: string; v: number } | null;
  now: { ts: string; v: number } | null;
}

function keyPoints(history: SourceLineHistory, label: Label): TrendKeyPoints {
  const pts = history.points.map((p) => ({ ts: p.ts, t: Date.parse(p.ts), v: p.probs[label] }));
  const nowMs = Date.now();
  const at = (hoursAgo: number): { ts: string; v: number } | null => {
    const target = nowMs - hoursAgo * 3600_000;
    const before = pts.filter((p) => p.t <= target);
    return before.length ? before[before.length - 1] : null;
  };
  return {
    source: history.source,
    label,
    earliest: pts[0] ?? null,
    h24: at(24),
    h6: at(6),
    now: pts.length ? pts[pts.length - 1] : null,
  };
}

function trendLine(kp: TrendKeyPoints): string | null {
  if (!kp.now || !kp.earliest) return null;
  const start = kp.h24 ?? kp.earliest;
  const mid = kp.h6;
  const delta = (kp.now.v - start.v) * 100;
  const segs = [
    `${kp.h24 ? "24h前" : `最早(${bjFull.format(new Date(kp.earliest.ts))})`} ${pct(start.v)}`,
    mid ? `6h前 ${pct(mid.v)}` : null,
    `现在 ${pct(kp.now.v)}`,
  ].filter(Boolean);
  return `${kp.source} ${LABEL_ZH[kp.label]}: ${segs.join(" → ")}(Δ ${pp(delta)})`;
}

export interface MatchContext {
  fixtureKey: string;
  match: string;
  matchZh: string;
  kickoffUtc: string;
  prompt: string; // user 消息全文
}

export function buildMatchContext(fixtureKey: string): MatchContext | null {
  const row = getCurrentOdds(70).find((r) => r.fixtureKey === fixtureKey);
  if (!row) return null;

  const zhHome = zhTeamName(row.homeTeam) ?? row.homeTeam;
  const zhAway = zhTeamName(row.awayTeam) ?? row.awayTeam;
  const matchZh = `${zhHome} vs ${zhAway}`;
  const kickoff = new Date(row.kickoffUtc);
  const hoursTo = (kickoff.getTime() - Date.now()) / 3600_000;

  const sections: string[] = [];

  // 1. 元信息
  sections.push(
    `## 比赛\n${matchZh}(${row.match})\n开球: ${bjFull.format(kickoff)} 北京时间(约 ${hoursTo.toFixed(1)} 小时后)`
  );

  // 2. 当前盘面
  const board: string[] = [];
  if (row.bookAvg) board.push(`国际书商中位(${row.books} 家): ${threeWayLine(row.bookAvg)}`);
  if (row.pinnacle) board.push(`Pinnacle(sharp 书商): ${threeWayLine(row.pinnacle)}`);
  if (row.polymarket) board.push(`Polymarket(预测市场): ${threeWayLine(row.polymarket)}`);
  if (row.kalshi) board.push(`Kalshi(预测市场): ${threeWayLine(row.kalshi)}`);
  if (row.sporttery) board.push(`中国体彩 HAD(归一后): ${threeWayLine(row.sporttery)}`);
  sections.push(`## 当前盘面(三向归一概率: 主胜/平/客胜)\n${board.join("\n")}`);

  // 3. 预计算价差信号
  const signals: string[] = [];
  if (row.sporttery && row.bookAvg) {
    signals.push(`体彩 − 书商中位: ${diffLine(row.sporttery, row.bookAvg)}(正值=体彩隐含概率偏高,回报相对差)`);
  }
  if (row.pinnacle && row.bookAvg) signals.push(`Pinnacle − 书商中位: ${diffLine(row.pinnacle, row.bookAvg)}`);
  if (row.polymarket && row.bookAvg) signals.push(`Polymarket − 书商中位: ${diffLine(row.polymarket, row.bookAvg)}`);
  if (row.kalshi && row.bookAvg) signals.push(`Kalshi − 书商中位: ${diffLine(row.kalshi, row.bookAvg)}`);
  if (row.polymarket && row.kalshi) signals.push(`Polymarket − Kalshi: ${diffLine(row.polymarket, row.kalshi)}`);
  if (signals.length) sections.push(`## 预计算价差(百分点)\n${signals.join("\n")}`);

  // 4. 走势摘要(关键点采样)
  const history = getLineHistory(fixtureKey, { hours: 48, bucketMinutes: 30 });
  const trendSources = history.filter((h) => ["polymarket", "kalshi", "pinnacle"].includes(h.source) && h.points.length >= 2);
  const trends: string[] = [];
  for (const h of trendSources) {
    for (const label of LABELS) {
      const line = trendLine(keyPoints(h, label));
      if (line) trends.push(line);
    }
  }
  // 异动只看主力源;长尾书商偶发离群/过期盘(实测 marathonbet ±37pp)会污染信号
  const jumps = trendSources
    .flatMap((h) => h.jumps.map((j) => ({ ...j, source: h.source })))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 6)
    .map((j) => `${bjFull.format(new Date(j.ts))} ${j.source} ${LABEL_ZH[j.label]} ${pp(j.deltaPp)}`);
  if (trends.length) {
    sections.push(
      `## 近 48h 走势(三向归一,关键点采样)\n${trends.join("\n")}` +
        (jumps.length ? `\n盘口异动(单步≥2pp): ${jumps.join(";")}` : "")
    );
  }

  // 5. 夺冠概率背景(实力锚)
  const outright = getOutrightBoard(64);
  const anchor: string[] = [];
  for (const [team, zh] of [
    [row.homeTeam, zhHome],
    [row.awayTeam, zhAway],
  ] as const) {
    const o = outright.find((r) => teamsMatch(r.team, team));
    if (o) {
      const parts: string[] = [];
      if (o.pm !== null) parts.push(`PM ${pct(o.pm)}${o.pmDeltaPp !== null ? `(Δ24h ${pp(o.pmDeltaPp)})` : ""}`);
      if (o.kalshi !== null) parts.push(`Kalshi ${pct(o.kalshi)}`);
      if (parts.length) anchor.push(`${zh}: ${parts.join(" · ")}`);
    }
  }
  if (anchor.length) sections.push(`## 夺冠概率背景(实力锚)\n${anchor.join("\n")}`);

  // 6. 体彩让球盘
  const hhad = getSportteryHhad(fixtureKey);
  if (hhad) {
    const line = Number(hhad.goalLine);
    const lineDesc = Number.isFinite(line)
      ? line < 0
        ? `${zhHome} 让 ${Math.abs(line)} 球`
        : line > 0
          ? `${zhHome} 受让 ${line} 球`
          : "平手盘"
      : hhad.goalLine;
    const sp = LABELS.map((l) => (hhad.sp[l] !== null ? hhad.sp[l]!.toFixed(2) : "-")).join("/");
    sections.push(`## 体彩让球胜平负 HHAD\n盘口: ${lineDesc};SP ${sp};归一隐含 ${threeWayLine(hhad.probs)}`);
  }

  // 7. 数据新鲜度(让模型知道哪些数据可能滞后)
  const fresh = getSourceFreshness()
    .map((f) => `${f.group} ${fmtAge(f.ageMs)}`)
    .join(" · ");
  sections.push(`## 数据新鲜度\n${fresh}(体彩为手动低频抓取,以官方实时 SP 为准)`);

  return {
    fixtureKey,
    match: row.match,
    matchZh,
    kickoffUtc: row.kickoffUtc,
    prompt: sections.join("\n\n"),
  };
}
