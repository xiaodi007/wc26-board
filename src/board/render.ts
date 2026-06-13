import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { API_FOOTBALL_KEY, WALRUS_AGGREGATOR_URL, WALRUS_FEED_DIR } from "../config.js";
import { getCompletedOdds, getCurrentOdds, LABELS, type CurrentOddsRow, type Label, type ThreeWay } from "../queries/currentOdds.js";
import { getLineHistory, type SourceLineHistory } from "../queries/lineHistory.js";
import { getSportteryEdges, type SportteryAvoidanceRow } from "../queries/sportteryAvoidance.js";
import { getOutrightBoard } from "../queries/outright.js";
import {
  compactMoney,
  compactNumber,
  formatThreeWayShort,
  getMarketRadar,
  getMatchIntelligence,
  percent,
  type MarketOpportunity,
  type MatchIntelligence,
  type OpportunityTag,
  type RiskLevel,
  type RiskSignal,
} from "../queries/marketIntelligence.js";
import { getProbabilityCandidates, type ProbabilityCandidate, type SourceContribution } from "../queries/probabilityModel.js";
import { getMatchEventBundle, type MatchEventBundle, type MatchEventRow } from "../queries/matchEvents.js";
import { fmtAge, getSourceFreshness, runHealthChecks } from "../queries/healthChecks.js";
import { getAllSportteryHhad, getSportteryHhad, type HhadBoardRow } from "../queries/hhad.js";
import { buildMatchContext } from "../ai/context.js";
import { aiProviderOptions, currentAiProvider, currentSystemPrompt, hasApiKey, type AnalysisVerdict } from "../ai/analyze.js";
import { latestBoardVerdict, type BoardBettingVerdict } from "../ai/boardPlan.js";
import { countAlerts24h, getMeta, listAnalyses, listRecentAlerts, listWalrusPublishLog, type AiAnalysisRow } from "../db.js";
import { normalizeTeam, zhTeamName } from "../teams.js";
import { lineChart, sparkline, type ChartSeries } from "./svg.js";
import {
  ACTION_LABELS,
  briefTag,
  briefText,
  briefTitle,
  COPY,
  explainMarket,
  LOCALE_NAME,
  marketTypeLabel,
  outcomeLabel,
  RISK_LEVEL_LABELS,
  RISK_NOTES,
  RISK_SIGNAL_TITLES,
  TAG_LABELS,
  type Locale,
} from "./i18n.js";

const LABEL_COLOR: Record<Label, string> = { home: "var(--lime)", draw: "var(--cyan)", away: "var(--violet)" };
const DIFF_PP = 2;
const MIN_BOOKS = 5;
const CARD_WINDOW_H = 48;
const SOURCE_COLOR: Record<string, string> = {
  polymarket: "var(--cyan)",
  kalshi: "var(--violet)",
  pinnacle: "var(--lime)",
  sporttery: "var(--amber)",
};
type PageActive = "home" | "opportunities" | "match" | "walrus" | "review";

function esc(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? "-" : `${(v * 100).toFixed(digits)}%`;
}

function signedPp(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}`;
}

function team(locale: Locale, name: string): string {
  return displayTeam(locale, name);
}

function titleCaseTeam(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part.length <= 2 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`))
    .join(" ");
}

function displayTeam(locale: Locale, name: string): string {
  if (locale === "zh") return zhTeamName(name) ?? name;
  return /[\u4e00-\u9fff]/.test(name) ? titleCaseTeam(normalizeTeam(name)) : name;
}

function localizedTeam(locale: Locale, name: string): string {
  return displayTeam(locale, name);
}

function matchName(locale: Locale, home: string, away: string): string {
  return `${localizedTeam(locale, home)} vs ${localizedTeam(locale, away)}`;
}

function matchNameFromRow(locale: Locale, row: CurrentOddsRow): string {
  return matchName(locale, row.homeTeam, row.awayTeam);
}

function localizeMatch(locale: Locale, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw.split(/\s+vs\.?\s+/i);
  return parts.length === 2 ? matchName(locale, parts[0], parts[1]) : raw;
}

function outcomeName(locale: Locale, row: CurrentOddsRow, label: Label): string {
  if (label === "home") return localizedTeam(locale, row.homeTeam);
  if (label === "away") return localizedTeam(locale, row.awayTeam);
  return outcomeLabel(locale, "draw");
}

function kickoffFormatter(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { timeZone: "Asia/Shanghai", ...opts });
}

function fullTime(locale: Locale, date: Date): string {
  return kickoffFormatter(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function clock(locale: Locale, date: Date): string {
  return kickoffFormatter(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function dayLabel(locale: Locale, kickoffUtc: string): string {
  const date = new Date(kickoffUtc);
  const key = dayKey(date);
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400_000));
  const formatted = kickoffFormatter(locale, { month: "2-digit", day: "2-digit", weekday: "short" }).format(date);
  if (key === today) return locale === "zh" ? `今天 ${formatted}` : `Today ${formatted}`;
  if (key === tomorrow) return locale === "zh" ? `明天 ${formatted}` : `Tomorrow ${formatted}`;
  return formatted;
}

function href(pathname: string, locale: Locale, params: Record<string, string> = {}): string {
  const url = new URL(pathname, "http://127.0.0.1");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("lang", locale);
  return `${url.pathname}${url.search}`;
}

function oppositeLocale(locale: Locale): Locale {
  return locale === "zh" ? "en" : "zh";
}

function riskBadge(locale: Locale, level: RiskLevel): string {
  const cls = level === "elevated" ? "bad" : level === "watch" ? "watch" : level === "low" ? "low" : "mute";
  return `<span class="badge ${cls}">${esc(RISK_LEVEL_LABELS[locale][level])}</span>`;
}

function diffBadge(locale: Locale, diffPp: number): string {
  if (diffPp >= DIFF_PP) return `<span class="badge bad">${signedPp(diffPp)} ${locale === "zh" ? "避坑" : "avoid"}</span>`;
  if (diffPp <= -DIFF_PP) return `<span class="badge low">${signedPp(diffPp)} ${locale === "zh" ? "划算" : "value"}</span>`;
  return `<span class="dim" style="font-size:11px;margin-left:3px">${signedPp(diffPp)}</span>`;
}

function sportteryDiffLine(locale: Locale, row: CurrentOddsRow): string {
  if (row.live) return `<div class="sporttery-line"><span class="dim">${locale === "zh" ? "体彩已停售" : "Sporttery closed"}</span></div>`;
  if (!row.sporttery) return `<div class="sporttery-line"><span class="dim">${locale === "zh" ? "体彩未开售/未抓取" : "Sporttery unavailable"}</span></div>`;
  if (!row.bookAvg || row.books < MIN_BOOKS) {
    return `<div class="sporttery-line"><span class="dim">Sporttery</span>${LABELS.map((label) => `<span>${esc(outcomeName(locale, row, label))} ${pct(row.sporttery![label])}</span>`).join("")}</div>`;
  }
  return (
    `<div class="sporttery-line"><span class="dim">Sporttery</span>` +
    LABELS.map((label) => {
      const diff = (row.sporttery![label] - row.bookAvg![label]) * 100;
      return `<span>${esc(outcomeName(locale, row, label))} ${pct(row.sporttery![label])}${diffBadge(locale, diff)}</span>`;
    }).join("") +
    `</div>`
  );
}

function hhadLineDesc(locale: Locale, goalLine: string, homeTeam: string): string {
  const line = Number(goalLine);
  if (!Number.isFinite(line)) return goalLine;
  if (locale !== "zh") return line < 0 ? `${homeTeam} -${Math.abs(line)}` : line > 0 ? `${homeTeam} +${line}` : "level";
  if (line < 0) return `${team(locale, homeTeam)} 让 ${Math.abs(line)} 球`;
  if (line > 0) return `${team(locale, homeTeam)} 受让 ${line} 球`;
  return "平手盘";
}

function tagClass(tag: OpportunityTag): string {
  if (tag === "high_risk") return "bad";
  if (tag === "high_liquidity" || tag === "beginner_friendly") return "low";
  if (tag === "data_missing" || tag === "sampled" || tag === "ai_probability_pending") return "mute";
  if (tag === "closing_soon" || tag === "price_movement") return "watch";
  return "info";
}

function tagList(locale: Locale, tags: OpportunityTag[], limit = 5): string {
  return tags
    .slice(0, limit)
    .map((tag) => `<span class="badge ${tagClass(tag)}">${esc(TAG_LABELS[locale][tag])}</span>`)
    .join("");
}

function scoreRing(score: number, label = ""): string {
  return `<div class="score-ring" style="--score:${Math.round(score)}" aria-label="${esc(label)}"><span>${Math.round(score)}</span></div>`;
}

function teamToken(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || name.slice(0, 2).toUpperCase();
}

function teamBadge(locale: Locale, name: string, side: "home" | "away"): string {
  return `<div class="team-badge ${side}"><span>${esc(teamToken(name))}</span><b>${esc(team(locale, name))}</b></div>`;
}

function consensusBar(locale: Locale, row: CurrentOddsRow, probs: ThreeWay): string {
  const seg = (label: Label): string =>
    `<div style="width:${(probs[label] * 100).toFixed(1)}%;background:${LABEL_COLOR[label]}" title="${esc(outcomeName(locale, row, label))} ${pct(probs[label])}"></div>`;
  return `<div class="prob-bar">${seg("home")}${seg("draw")}${seg("away")}</div>`;
}

function cardSpark(locale: Locale, row: CurrentOddsRow): string {
  const pm = getLineHistory(row.fixtureKey, { hours: 24, bucketMinutes: 30, sources: ["polymarket"] })[0];
  const emptyLabel = locale === "zh" ? "走势积累中" : "Trend pending";
  if (!pm || pm.points.length < 2) return sparkline([], { width: 128, height: 28, emptyLabel });
  return sparkline(pm.points.map((p) => p.probs.home), { width: 128, height: 28, emptyLabel });
}

function trendChart(locale: Locale, fixtureKey: string): string {
  const history = getLineHistory(fixtureKey, { hours: 48, bucketMinutes: 15 });
  const drawnSources = history.filter((s) => SOURCE_COLOR[s.source] && s.points.length > 0);
  if (!drawnSources.length) return `<p class="dim">${esc(COPY[locale].empty.trend)}</p>`;
  const ts = drawnSources.flatMap((s) => s.points.map((p) => Date.parse(p.ts)));
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const chart = (label: Label): string => {
    const series: ChartSeries[] = drawnSources.map((s: SourceLineHistory) => ({
      name: s.source,
      color: SOURCE_COLOR[s.source],
      dash: s.source === "kalshi" ? "5 3" : undefined,
      markersOnly: s.source === "sporttery",
      points: s.points.map((p) => ({ t: Date.parse(p.ts), v: p.probs[label] })),
    }));
    return `<div class="chart-cell"><div class="chart-title">${esc(outcomeLabel(locale, label))}</div>${lineChart(series, { tMin, tMax })}</div>`;
  };
  const legend = `<div class="legend">${drawnSources.map((s) => `<span><i style="background:${SOURCE_COLOR[s.source]}"></i>${esc(s.source)}</span>`).join("")}</div>`;
  return `${legend}<div class="chart-grid">${LABELS.map(chart).join("")}</div>`;
}

function reviewWindow(row: CurrentOddsRow): { fromTs: string; toTs: string } {
  const kickoff = Date.parse(row.kickoffUtc);
  return {
    fromTs: new Date(kickoff - 24 * 3600_000).toISOString(),
    toTs: new Date(kickoff + 2.5 * 3600_000).toISOString(),
  };
}

function reviewHistory(row: CurrentOddsRow): SourceLineHistory[] {
  const window = reviewWindow(row);
  return getLineHistory(row.fixtureKey, { fromTs: window.fromTs, toTs: window.toTs, bucketMinutes: 30 });
}

function eventMinuteLabel(locale: Locale, event: Pick<MatchEventRow, "minute" | "extraMinute">): string {
  if (event.minute === null) return "-";
  const extra = event.extraMinute && event.extraMinute > 0 ? `+${event.extraMinute}` : "";
  return locale === "zh" ? `${event.minute}${extra} 分` : `${event.minute}${extra}'`;
}

function eventEpoch(row: CurrentOddsRow, event: MatchEventRow): number | null {
  if (event.minute === null) return null;
  const kickoff = Date.parse(row.kickoffUtc);
  if (!Number.isFinite(kickoff)) return null;
  return kickoff + (event.minute + (event.extraMinute ?? 0)) * 60_000;
}

function isGoalEvent(event: MatchEventRow): boolean {
  return (event.eventType ?? "").toLowerCase() === "goal" && !/(missed|cancelled|canceled|disallowed)/i.test(event.detail ?? "");
}

function reviewGoalMarkers(locale: Locale, row: CurrentOddsRow, bundle: MatchEventBundle): { t: number; label: string; color?: string }[] {
  return bundle.events
    .filter(isGoalEvent)
    .map((event): { t: number; label: string; color?: string } | null => {
      const t = eventEpoch(row, event);
      if (t === null) return null;
      const score = event.scoreHome !== null && event.scoreAway !== null ? `${event.scoreHome}-${event.scoreAway}` : eventMinuteLabel(locale, event);
      return { t, label: score, color: "var(--amber)" };
    })
    .filter((row): row is { t: number; label: string; color?: string } => row !== null);
}

function reviewTrendChart(locale: Locale, row: CurrentOddsRow, history: SourceLineHistory[], markers: { t: number; label: string; color?: string }[] = []): string {
  const drawnSources = history.filter((s) => SOURCE_COLOR[s.source] && s.points.length > 0);
  if (!drawnSources.length) return `<p class="dim">${locale === "zh" ? "这场比赛暂无可复盘的赔率走势。" : "No reviewable odds history for this match yet."}</p>`;
  const { fromTs, toTs } = reviewWindow(row);
  const tMin = Date.parse(fromTs);
  const tMax = Date.parse(toTs);
  const chart = (label: Label): string => {
    const series: ChartSeries[] = drawnSources.map((s) => ({
      name: s.source,
      color: SOURCE_COLOR[s.source],
      dash: s.source === "kalshi" ? "5 3" : undefined,
      markersOnly: s.source === "sporttery",
      points: s.points.map((p) => ({ t: Date.parse(p.ts), v: p.probs[label] })),
    }));
    return `<div class="chart-cell"><div class="chart-title">${esc(outcomeLabel(locale, label))}</div>${lineChart(series, { tMin, tMax, markers })}</div>`;
  };
  const legend = `<div class="legend">${drawnSources.map((s) => `<span><i style="background:${SOURCE_COLOR[s.source]}"></i>${esc(s.source)}</span>`).join("")}</div>`;
  return `${legend}<div class="chart-grid">${LABELS.map(chart).join("")}</div>`;
}

function sourcePriority(source: string): number {
  if (source === "polymarket") return 0;
  if (source === "kalshi") return 1;
  if (source === "pinnacle") return 2;
  if (source === "sporttery") return 3;
  return 9;
}

function reviewJumpRows(history: SourceLineHistory[]): { source: string; label: Label; deltaPp: number; ts: string }[] {
  return history
    .flatMap((s) => s.jumps.map((j) => ({ ...j, source: s.source })))
    .sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || Math.abs(b.deltaPp) - Math.abs(a.deltaPp));
}

function nearestGoalPhrase(locale: Locale, row: CurrentOddsRow, bundle: MatchEventBundle, ts: string): string {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const candidates = bundle.events
    .filter(isGoalEvent)
    .map((event) => ({ event, t: eventEpoch(row, event) }))
    .filter((item): item is { event: MatchEventRow; t: number } => item.t !== null && item.t <= t && t - item.t <= 45 * 60_000)
    .sort((a, b) => b.t - a.t);
  const hit = candidates[0];
  if (!hit) return "";
  return locale === "zh" ? `，主要转折发生在${eventMinuteLabel(locale, hit.event)}后` : `, mostly after ${eventMinuteLabel(locale, hit.event)}`;
}

function reviewKeyTurn(locale: Locale, row: CurrentOddsRow, history: SourceLineHistory[], bundle: MatchEventBundle): string {
  const jump = reviewJumpRows(history).find((row) => sourcePriority(row.source) < 9) ?? reviewJumpRows(history)[0];
  if (!jump) return locale === "zh" ? "没有明显市场转折" : "No obvious market turn";
  const afterGoal = nearestGoalPhrase(locale, row, bundle, jump.ts);
  return `${jump.source} ${outcomeLabel(locale, jump.label)} ${signedPp(jump.deltaPp)}pp @ ${fullTime(locale, new Date(jump.ts))}${afterGoal}`;
}

function reviewAllJumps(locale: Locale, history: SourceLineHistory[]): string {
  const rows = reviewJumpRows(history).slice(0, 12);
  if (!rows.length) return `<p class="dim">${locale === "zh" ? "没有 >=2pp 的相邻窗口跳变。" : "No >=2pp adjacent-bucket jumps."}</p>`;
  return rows
    .map((jump) => `<div class="muted-line"><span class="badge ${sourcePriority(jump.source) < 9 ? "info" : "mute"}">${esc(jump.source)}</span>${esc(outcomeLabel(locale, jump.label))} <b class="${jump.deltaPp >= 0 ? "pos" : "neg"}">${signedPp(jump.deltaPp)}pp</b> @ ${esc(fullTime(locale, new Date(jump.ts)))}</div>`)
    .join("");
}

function reviewPmMove(locale: Locale, row: CurrentOddsRow, history: SourceLineHistory[], bundle: MatchEventBundle): string {
  const pm = history.find((s) => s.source === "polymarket");
  if (!pm || pm.points.length < 2) return locale === "zh" ? "PM 数据不足" : "PM data insufficient";
  const first = pm.points[0];
  const last = pm.points[pm.points.length - 1];
  const label = LABELS.map((outcome) => ({ outcome, delta: (last.probs[outcome] - first.probs[outcome]) * 100 })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  const afterGoal = nearestGoalPhrase(locale, row, bundle, last.ts);
  if (locale === "zh") {
    const verb = label.delta >= 0 ? "升到" : "降到";
    return `PM 对${outcomeLabel(locale, label.outcome)}的判断从 ${pct(first.probs[label.outcome], 0)} ${verb} ${pct(last.probs[label.outcome], 0)}（${signedPp(label.delta)}pp）${afterGoal}`;
  }
  return `PM moved ${outcomeLabel(locale, label.outcome)} from ${pct(first.probs[label.outcome], 0)} to ${pct(last.probs[label.outcome], 0)} (${signedPp(label.delta)}pp)${afterGoal}`;
}

function resultStatusLabel(locale: Locale, status: string | null): string {
  if (!status) return "-";
  if (locale !== "zh") return status;
  const map: Record<string, string> = {
    FT: "完场",
    AET: "加时完",
    PEN: "点球完",
    HT: "中场",
    "1H": "上半场",
    "2H": "下半场",
    NS: "未开赛",
    LIVE: "进行中",
  };
  return map[status] ?? status;
}

function reviewScoreboard(locale: Locale, row: CurrentOddsRow, bundle: MatchEventBundle): string {
  const result = bundle.result;
  const home = team(locale, row.homeTeam);
  const away = team(locale, row.awayTeam);
  if (result?.homeScore !== null && result?.homeScore !== undefined && result?.awayScore !== null && result?.awayScore !== undefined) {
    return (
      `<div class="review-scoreboard">` +
      `<div><span>${esc(home)}</span><b>${result.homeScore}</b></div>` +
      `<strong>${esc(resultStatusLabel(locale, result.status))}</strong>` +
      `<div><span>${esc(away)}</span><b>${result.awayScore}</b></div>` +
      `</div>`
    );
  }
  const gap = API_FOOTBALL_KEY
    ? locale === "zh"
      ? "赛果源已配置，但这场暂未匹配到比分；先展示赔率复盘。"
      : "Result source is configured, but this match has not been matched yet; showing odds review only."
    : locale === "zh"
      ? "未配置 API_FOOTBALL_KEY，当前只能做赔率复盘。"
      : "API_FOOTBALL_KEY is not configured, so this is odds review only.";
  return `<div class="review-scoreboard empty"><div><span>${esc(home)}</span><b>-</b></div><strong>${esc(gap)}</strong><div><span>${esc(away)}</span><b>-</b></div></div>`;
}

function eventSideLabel(locale: Locale, row: CurrentOddsRow, event: MatchEventRow): string {
  if (event.teamSide === "home") return team(locale, row.homeTeam);
  if (event.teamSide === "away") return team(locale, row.awayTeam);
  return event.teamName ? team(locale, event.teamName) : (locale === "zh" ? "未知球队" : "Unknown team");
}

function eventScoreText(event: MatchEventRow): string {
  return event.scoreHome !== null && event.scoreAway !== null ? `${event.scoreHome}-${event.scoreAway}` : "";
}

function eventText(locale: Locale, row: CurrentOddsRow, event: MatchEventRow): string {
  const type = event.detail || event.eventType || (locale === "zh" ? "事件" : "Event");
  const player = event.playerName ? ` · ${event.playerName}` : "";
  const assist = event.assistName ? (locale === "zh" ? `（助攻 ${event.assistName}）` : ` (assist ${event.assistName})`) : "";
  return `${eventSideLabel(locale, row, event)} · ${type}${player}${assist}`;
}

function reviewTimeline(locale: Locale, row: CurrentOddsRow, bundle: MatchEventBundle): string {
  if (!bundle.events.length) {
    const text = bundle.result
      ? locale === "zh"
        ? "已拿到比分，但当前来源不提供进球事件；接入 API-Football 后会显示时间轴。"
        : "Score is available, but this source does not provide goal events. API-Football will add the timeline."
      : API_FOOTBALL_KEY
        ? locale === "zh"
          ? "这场暂未匹配到进球事件。"
          : "No matched event timeline for this match yet."
        : locale === "zh"
          ? "未配置 API_FOOTBALL_KEY，暂无进球时间轴。"
          : "API_FOOTBALL_KEY is not configured, so no goal timeline is available.";
    return `<div class="event-timeline empty">${esc(text)}</div>`;
  }
  const shown = bundle.events.filter((event) => isGoalEvent(event) || ["Card", "subst", "Var"].includes(event.eventType ?? "")).slice(0, 18);
  if (!shown.length) return `<div class="event-timeline empty">${locale === "zh" ? "有事件源，但暂无进球/关键事件。" : "Events are available, but no goal/key event is present."}</div>`;
  return (
    `<div class="event-timeline">` +
    shown
      .map((event) => {
        const score = eventScoreText(event);
        return `<div class="event-item ${isGoalEvent(event) ? "goal" : ""}"><span class="mono">${esc(eventMinuteLabel(locale, event))}</span><b>${score ? esc(score) : " "}</b><p>${esc(eventText(locale, row, event))}</p></div>`;
      })
      .join("") +
    `</div>`
  );
}

function matchEventsPanel(locale: Locale, row: CurrentOddsRow): string {
  const bundle = getMatchEventBundle(row.fixtureKey);
  if (!bundle.result && !bundle.events.length && !row.live && Date.parse(row.kickoffUtc) > Date.now()) return "";
  return (
    `<section class="span12 panel"><div class="panel-head"><h2>${locale === "zh" ? "比分与事件" : "Score & Events"}</h2><a href="/api/match-events?fk=${encodeURIComponent(row.fixtureKey)}">JSON</a></div>` +
    reviewScoreboard(locale, row, bundle) +
    `<div style="margin-top:12px">${reviewTimeline(locale, row, bundle)}</div>` +
    `</section>`
  );
}

function freshnessGroup(locale: Locale, group: string): string {
  if (locale === "zh") return group;
  if (group === "书商") return "Books";
  if (group === "体彩") return "Sporttery";
  return group;
}

function freshnessChips(locale: Locale): string {
  return getSourceFreshness()
    .map((f) => {
      const cls = f.ageMs === null || f.ageMs > f.staleMs ? "stale" : f.ageMs > f.staleMs / 2 ? "warn" : "ok";
      return `<span class="chip ${cls}">${esc(freshnessGroup(locale, f.group))} <b>${fmtAge(f.ageMs)}</b></span>`;
    })
    .join("");
}

function walrusProof(locale: Locale): string {
  const t = COPY[locale];
  const blob = getMeta("walrus_latest_manifest_blob_id");
  const object = getMeta("walrus_latest_manifest_object_id");
  const publishedAt = getMeta("walrus_latest_published_at");
  const network = getMeta("walrus_latest_network") ?? "testnet";
  const schema = getMeta("walrus_latest_schema_version") ?? "wc26.market_radar.v1";
  const error = getMeta("walrus_latest_error");
  const status = error ? t.labels.syncDelayed : blob ? t.labels.latest : t.labels.notPublished;
  const badge = error ? "watch" : blob ? "low" : "mute";
  return (
    `<section class="panel proof-panel">` +
    `<div class="panel-head"><h2>${esc(t.sections.walrusProof)}</h2><span class="badge ${badge}">${esc(status)}</span></div>` +
    `<div class="proof-grid">` +
    `<div><span>${esc(t.labels.network)}</span><b>${esc(network)}</b></div>` +
    `<div><span>${esc(t.labels.schema)}</span><b>${esc(schema)}</b></div>` +
    `<div><span>${esc(t.labels.generated)}</span><b>${publishedAt ? esc(fullTime(locale, new Date(publishedAt))) : "-"}</b></div>` +
    `<div class="proof-blob"><span>${esc(t.labels.blob)}</span><b>${blob ? esc(blob) : esc(t.empty.walrus)}</b></div>` +
    `</div>${object ? `<div class="muted-line">object: <span class="mono">${esc(object)}</span></div>` : ""}` +
    `</section>`
  );
}

function money(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function latestBettingSummary(locale: Locale, verdict: BoardBettingVerdict | null): string {
  if (!verdict) {
    return `<div class="plan-empty">${locale === "zh" ? "还没有生成投注计划。填入本金、最大日亏损和临时 API key 后，可以直接生成；也可以先复制 prompt 到外部 AI。" : "No betting plan yet. Add bankroll, max daily loss, and a temporary API key, or copy the prompt."}</div>`;
  }
  const picks = verdict.recommendations
    .slice(0, 3)
    .map((pick) => `<span class="chip ok">${esc(pick.outcome.toUpperCase())} <b>${pct(pick.estimated_probability)}</b></span>`)
    .join("");
  return (
    `<p class="hero-sub">${esc(verdict.summary_zh)}</p>` +
    `<div class="mini" style="margin-top:8px">${picks || `<span class="chip">${locale === "zh" ? "暂无正 EV 建议" : "No positive-EV picks"}</span>`}</div>` +
    `<div class="muted-line">${locale === "zh" ? "资金纪律" : "Bankroll"}: ${esc(verdict.bankroll_note || "-")}</div>` +
    `<div class="muted-line">${locale === "zh" ? "数据质量" : "Data quality"}: ${esc(verdict.data_quality || "-")}</div>`
  );
}

function latestBettingCardSummary(locale: Locale, verdict: BoardBettingVerdict | null): string {
  if (!verdict) {
    return (
      `<p class="hero-sub">${locale === "zh" ? "还没有生成投注计划。打开弹窗后可以生成，或先复制 prompt 到外部 AI。" : "No betting plan yet. Open the dialog to generate one, or copy the prompt for an external AI."}</p>` +
      `<div class="mini" style="margin-top:8px"><span class="chip">${locale === "zh" ? "未生成" : "Not generated"}</span></div>`
    );
  }
  const picks = verdict.recommendations.length;
  return (
    `<p class="hero-sub">${esc(verdict.summary_zh || (locale === "zh" ? "已有计划，打开查看详情。" : "A plan is available. Open it for details."))}</p>` +
    `<div class="mini" style="margin-top:8px"><span class="chip ok">${locale === "zh" ? "推荐" : "Picks"} <b>${picks}</b></span><span class="chip">${locale === "zh" ? "观察" : "Watch"} <b>${verdict.watchlist.length}</b></span><span class="chip">${locale === "zh" ? "避开" : "Avoid"} <b>${verdict.avoid.length}</b></span></div>` +
    `<div class="muted-line">${locale === "zh" ? "资金纪律" : "Bankroll"}: ${esc(verdict.bankroll_note || "-")}</div>` +
    `<div class="muted-line">${locale === "zh" ? "数据质量" : "Data quality"}: ${esc(verdict.data_quality || "-")}</div>`
  );
}

function bettingPlanPanel(locale: Locale, model: ReturnType<typeof getMarketRadar>, fixtureKey?: string): string {
  const latest = latestBoardVerdict();
  const latestVerdict = latest?.verdict ?? null;
  const provider = currentAiProvider();
  const providerMeta = aiProviderOptions();
  const title = fixtureKey ? (locale === "zh" ? "本场投注计划" : "Match Betting Plan") : (locale === "zh" ? "AI 投注计划" : "AI Betting Plan");
  const hint = locale === "zh"
    ? "金额只在浏览器本次计算使用，不保存。默认 25% Kelly、单注最多 1% 本金，并受最大日亏损限制。"
    : "Amounts are used only for this browser request. Defaults: 25% Kelly, 1% max stake per pick, capped by max daily loss.";
  const matchNames = Object.fromEntries(model.matches.map((m) => [m.row.fixtureKey, matchNameFromRow(locale, m.row)]));
  const matchTeams = Object.fromEntries(
    model.matches.map((m) => [
      m.row.fixtureKey,
      {
        home: localizedTeam(locale, m.row.homeTeam),
        away: localizedTeam(locale, m.row.awayTeam),
        match: matchNameFromRow(locale, m.row),
      },
    ])
  );
  const providerOptions = providerMeta
    .map(({ id, label }) => `<option value="${id}"${provider.id === id ? " selected" : ""}>${label}</option>`)
    .join("");
  const currentMeta = providerMeta.find((p) => p.id === provider.id);
  const currentThinking = currentMeta?.defaultThinking === "enabled";
  return (
    `<section class="panel plan-panel plan-card" id="betting-plan">` +
    `<div class="panel-head"><h2>${esc(title)}</h2><span class="badge info">${locale === "zh" ? "25% Kelly 模拟" : "25% Kelly simulation"}</span></div>` +
    `<div class="plan-card-grid"><div id="plan-card-copy">${latestBettingCardSummary(locale, latestVerdict)}</div><div class="plan-card-actions"><button id="plan-open" type="button" class="btn primary" onclick="openBettingPlan()">${locale === "zh" ? "打开计划" : "Open plan"}</button><button type="button" class="btn" onclick="copyBoardPrompt()">${locale === "zh" ? "复制 prompt" : "Copy prompt"}</button><span id="plan-status" class="dim"></span></div></div>` +
    `</section>` +
    `<div class="plan-modal-backdrop" id="plan-modal" hidden onclick="if(event.target===this) closeBettingPlan()">` +
    `<section class="plan-modal" role="dialog" aria-modal="true" aria-labelledby="plan-modal-title">` +
    `<div class="plan-modal-head"><div><h2 id="plan-modal-title">${esc(title)}</h2><p class="opp-note">${esc(hint)}</p></div><button type="button" class="icon-btn" aria-label="${locale === "zh" ? "关闭" : "Close"}" onclick="closeBettingPlan()">x</button></div>` +
    `<div class="plan-modal-body">` +
    `<div class="plan-config" data-fixture="${esc(fixtureKey ?? "")}">` +
    `<label>${locale === "zh" ? "本金" : "Bankroll"}<input id="plan-bankroll" type="number" min="1" step="1" placeholder="10000" autocomplete="off"></label>` +
    `<label>${locale === "zh" ? "最大日亏损" : "Max daily loss"}<input id="plan-loss" type="number" min="1" step="1" placeholder="300" autocomplete="off"></label>` +
    `<label>Provider<select id="plan-provider">${providerOptions}</select></label>` +
    `<label>Base URL<input id="plan-base" value="${esc(provider.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off"></label>` +
    `<label>Model<input id="plan-model" value="${esc(provider.model === "(未配置)" ? "" : provider.model)}" placeholder="model" autocomplete="off"></label>` +
    `<label class="switch-label">Thinking<span class="switch-row"><input id="plan-thinking" type="checkbox"${currentThinking ? " checked" : ""}${currentMeta?.thinkingSupported ? "" : " disabled"}><span>${locale === "zh" ? "深度思考" : "Reasoning"}</span></span></label>` +
    `<label>API key<input id="plan-key" type="password" placeholder="${esc(provider.requiredKeyName)}" autocomplete="off"></label>` +
    `</div>` +
    `<details class="plan-advanced"><summary>${locale === "zh" ? "高级设置" : "Advanced settings"}</summary><div class="plan-config compact-config"><label>Max tokens<input id="plan-max-tokens" type="number" min="1" step="1" placeholder="${locale === "zh" ? "留空=不限制兼容接口" : "blank = provider default"}" autocomplete="off"></label></div></details>` +
    `<div class="mini" style="margin:10px 0"><button id="plan-go" type="button" class="btn primary" onclick="generateBettingPlan()">${fixtureKey ? (locale === "zh" ? "按当前本金生成本场计划" : "Generate match plan") : (locale === "zh" ? "生成投注计划" : "Generate betting plan")}</button><button type="button" class="btn" onclick="copyBoardPrompt()">${locale === "zh" ? "复制完整 prompt" : "Copy full prompt"}</button><button type="button" class="btn" onclick="copyBettingList()">${locale === "zh" ? "复制投注清单" : "Copy bet list"}</button><button type="button" class="btn" onclick="clearLocalPlan()">${locale === "zh" ? "清除本地计划" : "Clear local plan"}</button></div>` +
    `<div id="plan-progress" class="plan-progress" hidden><b>${locale === "zh" ? "AI 正在读盘" : "AI is reading the board"}</b><span id="plan-progress-text">${locale === "zh" ? "已等待 0 秒；通常 20-90 秒。" : "Waited 0s; usually 20-90s."}</span></div>` +
    `<div id="plan-output">${latestBettingSummary(locale, latestVerdict)}</div>` +
    `</div>` +
    `</section>` +
    `</div>` +
    `<script>
window.__matchNames=${JSON.stringify(matchNames)};
window.__matchTeams=${JSON.stringify(matchTeams)};
window.__planFixture=${JSON.stringify(fixtureKey ?? "")};
window.__aiProviders=${JSON.stringify(Object.fromEntries(providerMeta.map((p) => [p.id, p])))};
window.__lastPlanData=null;
window.__planAbortController=null;
function planMoney(v){ return Number.isFinite(v) ? "¥"+v.toLocaleString(undefined,{maximumFractionDigits:2}) : "-"; }
function planPct(v){ return Number.isFinite(v) ? (v*100).toFixed(1)+"%" : "-"; }
function planSignedPp(v){ return Number.isFinite(v) ? (v>=0?"+":"")+v.toFixed(1)+"pp" : "-"; }
function planOutcome(row){
  var teams=(window.__matchTeams||{})[row.fixture_key] || {};
  if(row.outcome==="home") return ${JSON.stringify(locale === "zh" ? "主胜" : "Home")}+(teams.home?"（"+teams.home+"）":"");
  if(row.outcome==="away") return ${JSON.stringify(locale === "zh" ? "客胜" : "Away")}+(teams.away?"（"+teams.away+"）":"");
  if(row.outcome==="draw") return ${JSON.stringify(locale === "zh" ? "平局" : "Draw")};
  return String(row.outcome||"");
}
function h(v){ return String(v==null?"":v).replace(/[&<>"]/g,function(c){ if(c==="&") return "&amp;"; if(c==="<") return "&lt;"; if(c===">") return "&gt;"; return "&quot;"; }); }
function explicitPlanLang(){
  var lang=new URLSearchParams(location.search).get("lang");
  return lang==="zh" || lang==="en" ? lang : "";
}
function planApiUrl(path){
  var params=new URLSearchParams();
  var lang=explicitPlanLang();
  if(lang) params.set("lang", lang);
  return path + (params.toString() ? "?" + params.toString() : "");
}
function planPromptUrl(){
  var params=new URLSearchParams();
  if(window.__planFixture) params.set("fk", window.__planFixture);
  var lang=explicitPlanLang();
  if(lang) params.set("lang", lang);
  return "/api/board-prompt" + (params.toString() ? "?" + params.toString() : "");
}
function localPlanKey(){
  var lang=explicitPlanLang() || ${JSON.stringify(locale)};
  return "wc26.plan.v1:"+lang+":"+(window.__planFixture || "all");
}
function setPlanStatus(text){
  var status=document.getElementById("plan-status");
  if(status) status.textContent=text||"";
}
function planOutput(html){
  var out=document.getElementById("plan-output");
  if(out) out.innerHTML=html;
}
function saveLocalPlan(data, body){
  if(!data || !data.plan || !data.verdict) return;
  var saved={verdict:data.verdict,plan:data.plan,model:data.model||"",generatedAt:new Date().toISOString(),bankroll:body.bankroll,maxDailyLoss:body.maxDailyLoss,provider:body.provider,constants:data.constants||null};
  try{ localStorage.setItem(localPlanKey(), JSON.stringify(saved)); }catch(e){}
  window.__lastPlanData=saved;
}
function loadLocalPlan(){
  try{
    var raw=localStorage.getItem(localPlanKey());
    if(!raw) return null;
    var parsed=JSON.parse(raw);
    if(!parsed || !parsed.plan || !parsed.verdict) return null;
    return parsed;
  }catch(e){ return null; }
}
function restoreLocalPlan(){
  var saved=loadLocalPlan();
  if(!saved) return false;
  window.__lastPlanData=saved;
  var bankroll=document.getElementById("plan-bankroll");
  var loss=document.getElementById("plan-loss");
  if(bankroll && !bankroll.value && saved.bankroll) bankroll.value=saved.bankroll;
  if(loss && !loss.value && saved.maxDailyLoss) loss.value=saved.maxDailyLoss;
  renderPlan(saved,{fromLocal:true});
  setPlanStatus(${JSON.stringify(locale === "zh" ? "已恢复本地计划" : "Restored local plan")});
  return true;
}
function clearLocalPlan(){
  try{ localStorage.removeItem(localPlanKey()); }catch(e){}
  window.__lastPlanData=null;
  planOutput("<div class='plan-empty'>${locale === "zh" ? "本地计划已清除。可以重新生成，或复制 prompt 到外部 AI。" : "Local plan cleared. Generate again or copy the prompt."}</div>");
  setPlanStatus(${JSON.stringify(locale === "zh" ? "本地计划已清除" : "Local plan cleared")});
}
function openBettingPlan(){
  var modal=document.getElementById("plan-modal");
  if(!modal) return;
  modal.hidden=false;
  document.body.classList.add("modal-open");
  window.__pauseAutoRefresh=true;
  restoreLocalPlan();
  setTimeout(function(){ var el=document.getElementById("plan-bankroll") || document.getElementById("plan-go"); if(el) el.focus(); }, 0);
}
function closeBettingPlan(){
  var modal=document.getElementById("plan-modal");
  if(modal) modal.hidden=true;
  ["plan-bankroll","plan-loss","plan-key"].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=""; });
  document.body.classList.remove("modal-open");
  window.__pauseAutoRefresh=false;
  var open=document.getElementById("plan-open"); if(open) open.focus();
}
function planInputs(){
  return {
    fixtureKey: window.__planFixture || undefined,
    bankroll: Number(document.getElementById("plan-bankroll").value),
    maxDailyLoss: Number(document.getElementById("plan-loss").value),
    provider: document.getElementById("plan-provider").value,
    baseUrl: document.getElementById("plan-base").value,
    model: document.getElementById("plan-model").value,
    thinking: document.getElementById("plan-thinking").checked ? "enabled" : "disabled",
    maxTokens: document.getElementById("plan-max-tokens").value,
    apiKey: document.getElementById("plan-key").value
  };
}
function syncPlanProviderDefaults(){
  var providerId=document.getElementById("plan-provider").value;
  var meta=(window.__aiProviders||{})[providerId] || {};
  var base=document.getElementById("plan-base");
  var model=document.getElementById("plan-model");
  var thinking=document.getElementById("plan-thinking");
  if(base && base.dataset.userEdited!=="1"){
    base.value=meta.baseUrl || "";
    base.placeholder=meta.baseUrl || "https://api.example.com/v1";
  }
  if(model && model.dataset.userEdited!=="1"){
    model.value=meta.modelHint || "";
    model.placeholder=meta.modelHint || "model";
  }
  if(thinking){
    thinking.disabled=!meta.thinkingSupported;
    thinking.checked=meta.defaultThinking==="enabled";
  }
}
function planSourceLine(data, opts){
  var parts=[];
  if(data.generatedAt) parts.push(${JSON.stringify(locale === "zh" ? "生成" : "Generated")}+" "+new Date(data.generatedAt).toLocaleString());
  if(data.model) parts.push("model "+data.model);
  if(data.provider) parts.push("provider "+data.provider);
  if(opts && opts.fromLocal) parts.push(${JSON.stringify(locale === "zh" ? "本机保存" : "local saved")});
  return parts.length ? "<div class='muted-line'>"+parts.map(h).join(" · ")+"</div>" : "";
}
function readableVerdict(data){
  var s=data.plan.summary || {};
  var bets=(data.plan.rows||[]).filter(function(r){return r.bucket==="bet" && r.stake>0;});
  if(!bets.length) return ${JSON.stringify(locale === "zh" ? "今天不建议下注：没有方向同时满足正 EV、赔率和风险门槛。" : "No bet recommended: no direction clears EV, price, and risk thresholds.")};
  return ${JSON.stringify(locale === "zh" ? "当前建议 " : "Recommended ")}+bets.length+${JSON.stringify(locale === "zh" ? " 注，总金额 " : " bets, total stake ")}+planMoney(s.totalStake)+${JSON.stringify(locale === "zh" ? "，最坏亏损 " : ", worst loss ")}+planMoney(s.worstCaseLoss)+"。";
}
function betCard(r){
  var match=window.__matchNames[r.fixture_key] || r.fixture_key;
  return "<div class='plan-bet-card'><div><div class='opp-title'>${locale === "zh" ? "买 " : "Buy "}"+h(planOutcome(r))+" · "+h(match)+"</div><p class='opp-note'>"+h(r.offeredOdd.platform)+" · ${locale === "zh" ? "赔率" : "odds"} "+Number(r.offeredOdd.decimalOdds).toFixed(3)+" · ${locale === "zh" ? "建议金额" : "stake"} <b>"+planMoney(r.stake)+"</b> · ${locale === "zh" ? "最大亏损" : "max loss"} "+planMoney(r.maxLoss)+" · EV "+planMoney(r.expectedValue)+"</p><p class='opp-note'>"+h(r.reason||"")+"</p><div class='muted-line'>${locale === "zh" ? "撤销条件" : "Cancel if"}: "+h(r.cancel_if||"-")+"</div><div class='muted-line'>${locale === "zh" ? "风险" : "Risk"}: "+h(r.risk||"-")+"</div></div><div class='plan-numbers'><span>${locale === "zh" ? "模型概率" : "Model p"} <b>"+planPct(r.estimated_probability)+"</b></span><span>${locale === "zh" ? "市场概率" : "Market p"} <b>"+planPct(r.marketImpliedProbability)+"</b></span><span>Edge <b class='"+(r.edgePp>=0?"pos":"neg")+"'>"+planSignedPp(r.edgePp)+"</b></span><span>EV/stake <b>"+planPct(r.evPctStake)+"</b></span></div></div>";
}
function planItemRows(rows, type){
  if(!rows.length) return "<div class='plan-empty'>"+(type==="watch"?${JSON.stringify(locale === "zh" ? "暂无需要等待的方向。" : "No watch-only directions.")}:${JSON.stringify(locale === "zh" ? "暂无明确避坑项。" : "No explicit avoid items.")})+"</div>";
  return rows.map(function(r){
    var match=window.__matchNames[r.fixture_key]||r.fixture_key;
    var main=type==="watch" ? (r.trigger||r.take||"") : (r.take||"");
    return "<div class='plan-lite-row'><b>"+h(match)+" · "+h(planOutcome(r))+"</b><p>"+h(main||"-")+"</p><span>"+h(r.risk||"")+"</span></div>";
  }).join("");
}
function renderPlan(data, opts){
  if(!data || !data.plan || !data.verdict){ planOutput("<div class='plan-empty'>${locale === "zh" ? "AI 没有返回可解析计划。" : "AI did not return a parsable plan."}</div>"); return; }
  window.__lastPlanData=data;
  var s=data.plan.summary;
  var bets=data.plan.rows.filter(function(r){return r.bucket==="bet" && r.stake>0;});
  var watch=(data.verdict.watchlist||[]).slice(0,6);
  var avoid=(data.verdict.avoid||[]).slice(0,6);
  var formula="<details class='details-panel'><summary>${locale === "zh" ? "公式细节" : "Formula details"}</summary><p class='opp-note'>Kelly fraction = 25% × raw Kelly；单注上限 = 本金 1%；总下注受最大日亏损限制。EV = stake × (model_probability × decimal_odds - 1)。这里只是个人研究，不保证收益。</p></details>";
  var summary="<div class='plan-summary'><div><span>${locale === "zh" ? "总下注" : "Total stake"}</span><b>"+planMoney(s.totalStake)+"</b></div><div><span>${locale === "zh" ? "最坏亏损" : "Worst loss"}</span><b>"+planMoney(s.worstCaseLoss)+"</b></div><div><span>${locale === "zh" ? "全中净收益" : "All-win profit"}</span><b>"+planMoney(s.allWinNetProfit)+"</b></div><div><span>${locale === "zh" ? "期望收益" : "Expected value"}</span><b>"+planMoney(s.expectedValue)+"</b></div><div><span>${locale === "zh" ? "预计亏损概率" : "Approx. loss prob."}</span><b>"+(s.approximateLossProbability===null?"-":planPct(s.approximateLossProbability))+"</b></div></div>";
  var betHtml=bets.length ? bets.map(betCard).join("") : "<div class='plan-empty'>${locale === "zh" ? "当前没有达到正 EV + 2pp 门槛的下注建议。" : "No pick cleared the positive-EV + 2pp threshold."}</div>";
  planOutput("<div class='plan-verdict'>"+h(readableVerdict(data))+"</div>"+planSourceLine(data,opts)+"<p class='hero-sub'>"+h(data.verdict.summary_zh||"")+"</p>"+summary+"<div class='plan-bucket good'><h3>${locale === "zh" ? "可以买" : "Can buy"}</h3>"+betHtml+"</div><div class='plan-bucket watch'><h3>${locale === "zh" ? "先观察" : "Watch first"}</h3>"+planItemRows(watch,'watch')+"</div><div class='plan-bucket avoid'><h3>${locale === "zh" ? "别买 / 避坑" : "Avoid"}</h3>"+planItemRows(avoid,'avoid')+"</div>"+formula);
  var card=document.getElementById("plan-card-copy");
  if(card){
    card.innerHTML="<p class='hero-sub'>"+h(readableVerdict(data))+"</p><div class='mini' style='margin-top:8px'><span class='chip ok'>${locale === "zh" ? "可以买" : "Buy"} <b>"+bets.length+"</b></span><span class='chip'>${locale === "zh" ? "观察" : "Watch"} <b>"+watch.length+"</b></span><span class='chip'>${locale === "zh" ? "避开" : "Avoid"} <b>"+avoid.length+"</b></span></div><div class='muted-line'>${locale === "zh" ? "资金纪律" : "Bankroll"}: "+h(data.verdict.bankroll_note||"-")+"</div><div class='muted-line'>${locale === "zh" ? "数据质量" : "Data quality"}: "+h(data.verdict.data_quality||"-")+"</div>";
  }
}
function setPlanBusy(b){
  window.__busy=b;
  var btn=document.getElementById("plan-go");
  if(btn){ btn.disabled=b; btn.textContent=b?${JSON.stringify(locale === "zh" ? "生成中..." : "Generating...")}:${JSON.stringify(fixtureKey ? (locale === "zh" ? "按当前本金生成本场计划" : "Generate match plan") : (locale === "zh" ? "生成投注计划" : "Generate betting plan"))}; }
}
function showPlanError(title, detail){
  planOutput("<div class='plan-empty plan-error'><b>"+h(title)+"</b><pre>"+h(detail||"")+"</pre></div>");
}
async function generateBettingPlan(){
  setPlanBusy(true);
  setPlanStatus(${JSON.stringify(locale === "zh" ? "生成中..." : "Generating...")});
  var progress=document.getElementById("plan-progress");
  var progressText=document.getElementById("plan-progress-text");
  if(progress) progress.hidden=false;
  var started=Date.now();
  var slowNotice=false;
  var timer=setInterval(function(){
    var sec=Math.floor((Date.now()-started)/1000);
    if(sec>=120) slowNotice=true;
    if(progressText) progressText.textContent=slowNotice?${JSON.stringify(locale === "zh" ? "已等待 " : "Waited ")}+sec+${JSON.stringify(locale === "zh" ? " 秒；仍在等待，可继续等或稍后重试。" : "s; still waiting. You can keep waiting or retry later.")}:${JSON.stringify(locale === "zh" ? "已等待 " : "Waited ")}+sec+${JSON.stringify(locale === "zh" ? " 秒；通常 20-90 秒。" : "s; usually 20-90s.")};
  },1000);
  try{
    var body=planInputs();
    window.__planAbortController=new AbortController();
    var res=await fetch(planApiUrl("/api/analyze-board"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:window.__planAbortController.signal});
    var data=await res.json();
    if(!res.ok) throw new Error(data.message||data.error||res.status);
    data.generatedAt=new Date().toISOString();
    data.provider=body.provider;
    saveLocalPlan(data, body);
    renderPlan(data);
    setPlanStatus(${JSON.stringify(locale === "zh" ? "完成，已保存到本机" : "Done, saved locally")});
  }catch(e){
    var msg=e && e.stack ? e.stack : (e && e.message ? e.message : String(e));
    setPlanStatus((${JSON.stringify(locale === "zh" ? "失败: " : "Failed: ")})+(e.message||String(e)));
    showPlanError(${JSON.stringify(locale === "zh" ? "生成失败" : "Generation failed")}, msg);
  }
  finally{ clearInterval(timer); if(progress) progress.hidden=true; setPlanBusy(false); window.__planAbortController=null; }
}
function bettingListText(data){
  if(!data || !data.plan) return ${JSON.stringify(locale === "zh" ? "暂无本地投注计划" : "No local betting plan")};
  var bets=(data.plan.rows||[]).filter(function(r){return r.bucket==="bet" && r.stake>0;});
  var lines=[readableVerdict(data)];
  bets.forEach(function(r){
    var match=window.__matchNames[r.fixture_key]||r.fixture_key;
    lines.push("买 "+planOutcome(r)+" · "+match+" · "+r.offeredOdd.platform+" @ "+Number(r.offeredOdd.decimalOdds).toFixed(3)+" · "+planMoney(r.stake)+" · max loss "+planMoney(r.maxLoss)+" · EV "+planMoney(r.expectedValue));
  });
  if(!bets.length) lines.push(${JSON.stringify(locale === "zh" ? "没有满足条件的下注。" : "No qualifying bets.")});
  return lines.join("\\n");
}
async function copyBettingList(){
  var data=window.__lastPlanData || loadLocalPlan();
  await navigator.clipboard.writeText(bettingListText(data));
  setPlanStatus(${JSON.stringify(locale === "zh" ? "投注清单已复制" : "Bet list copied")});
}
async function copyBoardPrompt(){
  var status=document.getElementById("plan-status");
  var res=await fetch(planPromptUrl());
  var data=await res.json();
  var text=data.system+"\\n\\n---\\n\\n"+data.context.prompt;
  await navigator.clipboard.writeText(text);
  if(status) status.textContent=${JSON.stringify(locale === "zh" ? "prompt 已复制" : "Prompt copied")};
}
document.addEventListener("keydown",function(e){ if(e.key==="Escape"){ var modal=document.getElementById("plan-modal"); if(modal && !modal.hidden) closeBettingPlan(); } });
["plan-base","plan-model"].forEach(function(id){
  var el=document.getElementById(id);
  if(el){ el.addEventListener("input",function(){ el.dataset.userEdited="1"; }); }
});
var providerSelect=document.getElementById("plan-provider");
if(providerSelect) providerSelect.addEventListener("change",syncPlanProviderDefaults);
["plan-bankroll","plan-loss","plan-provider","plan-base","plan-model","plan-thinking","plan-key","plan-max-tokens"].forEach(function(id){
  var el=document.getElementById(id);
  if(el){ el.addEventListener("focus",function(){window.__pauseAutoRefresh=true;}); el.addEventListener("input",function(){window.__pauseAutoRefresh=true;}); }
});
</script>`
  );
}

function metricStrip(locale: Locale, model = getMarketRadar()): string {
  const t = COPY[locale];
  const m = model.metrics;
  const cards = [
    [t.metrics.totalMarkets, compactNumber(m.totalMarkets), t.metricHints.totalMarkets],
    [t.metrics.volume24h, compactMoney(m.pmVolume24h), t.metricHints.volume24h],
    [t.metrics.pmLiquidity, compactMoney(m.pmLiquidity), t.metricHints.pmLiquidity],
    [t.metrics.activeTraders, compactNumber(m.pmActiveTraders24h), t.metricHints.activeTraders],
    [t.metrics.holderDepth, compactNumber(m.pmTopHolderDepth), t.metricHints.holderDepth],
    [t.metrics.closingSoon, compactNumber(m.closingSoon), t.metricHints.closingSoon],
    [t.metrics.divergence, compactNumber(m.oddsDivergence), t.metricHints.divergence],
    [t.metrics.opportunities, compactNumber(m.aiOpportunityCount), t.metricHints.opportunities],
  ];
  return `<div class="metric-strip">${cards
    .map(([label, value, hint]) => `<div class="metric-card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`)
    .join("")}</div>`;
}

function aiBrief(locale: Locale, model = getMarketRadar()): string {
  const t = COPY[locale];
  return (
    `<aside class="ai-brief"><details><summary><span class="spark-dot"></span><b>${esc(t.aiBrief)}</b><span class="badge info">${esc(t.signals)}</span></summary>` +
    `<div class="brief-list">${model.aiBrief
      .slice(0, 5)
      .map((item) => {
        const match = localizeMatch(locale, item.match);
        const outcome = item.outcomeName && item.outcomeName !== "Draw" ? team(locale, item.outcomeName) : item.outcomeName === "Draw" ? outcomeLabel(locale, "draw") : undefined;
        return `<div class="brief-item"><div><b>${esc(briefTitle(locale, item))}</b>${riskBadge(locale, item.level)}</div><p>${esc(briefText(locale, item, match, outcome))}</p><span class="brief-tag">${esc(briefTag(locale, item))}</span></div>`;
      })
      .join("")}</div></details></aside>`
  );
}

function sidebar(locale: Locale, active: PageActive): string {
  const t = COPY[locale];
  const item = (key: keyof typeof t.sidebar, url: string, icon: string, isActive = false): string =>
    `<a class="${isActive ? "active" : ""}" href="${esc(url)}"><span>${icon}</span><b>${esc(t.sidebar[key])}</b></a>`;
  return (
    `<aside class="sidebar">` +
    `<a class="brand" href="${href("/", locale)}"><span class="brand-mark">W</span><div><strong>${esc(t.appName)}</strong><small>${esc(t.appSub)}</small></div></a>` +
    `<nav class="side-nav">` +
    item("radar", href("/", locale), "⌘", active === "home") +
    item("opportunities", href("/opportunities", locale), "◇", active === "opportunities") +
    item("review", href("/review", locale), "↺", active === "review") +
    item("walrus", href("/walrus", locale), "W", active === "walrus") +
    item("alerts", `${href("/", locale)}#alerts`, "◌") +
    item("api", "/api/radar", "↗") +
    `</nav>` +
    `<div class="side-card"><b>${esc(t.worldCup)}</b><span>2026.06.11 - 07.19</span><small>${esc(t.freeTier)}</small></div>` +
    `</aside>`
  );
}

function topbar(
  locale: Locale,
  active: PageActive,
  model = getMarketRadar(),
  switchPath = active === "opportunities" ? "/opportunities" : active === "walrus" ? "/walrus" : active === "review" ? "/review" : "/",
  switchParams: Record<string, string> = {}
): string {
  const t = COPY[locale];
  const other = oppositeLocale(locale);
  const options = model.matches
    .slice(0, 70)
    .map((m) => `<option value="${esc(matchName(locale, m.row.homeTeam, m.row.awayTeam))}" data-fk="${esc(m.row.fixtureKey)}"></option>`)
    .join("");
  return (
    `<header class="topbar">` +
    `<form class="search" action="/match" method="get" onsubmit="return goMatchSearch(this)">` +
    `<input name="q" list="match-list" placeholder="${esc(t.search)}" autocomplete="off">` +
    `<input type="hidden" name="fk"><input type="hidden" name="lang" value="${locale}"><datalist id="match-list">${options}</datalist>` +
    `</form>` +
    `<nav class="top-nav"><a class="${active === "home" ? "active" : ""}" href="${href("/", locale)}">${esc(t.home)}</a><a class="${active === "opportunities" ? "active" : ""}" href="${href("/opportunities", locale)}">${esc(t.opportunities)}</a><a class="${active === "review" ? "active" : ""}" href="${href("/review", locale)}">${esc(t.sidebar.review)}</a><a class="${active === "walrus" ? "active" : ""}" href="${href("/walrus", locale)}">Walrus</a></nav>` +
    `<div class="top-actions">${freshnessChips(locale)}<a class="lang-pill" href="${href(switchPath, other, switchParams)}">${esc(LOCALE_NAME[other])}</a><a class="lang-pill" href="${active === "match" ? "#ai" : "#brief"}">${esc(t.aiBrief)}</a></div>` +
    `<script>
function goMatchSearch(form){
  var q=(form.q.value||"").toLowerCase();
  var opts=[].slice.call(document.querySelectorAll("#match-list option"));
  var hit=opts.find(function(o){return (o.value||"").toLowerCase()===q;}) || opts.find(function(o){return (o.value||"").toLowerCase().indexOf(q)>=0;});
  if(hit){ form.fk.value=hit.dataset.fk; form.q.disabled=true; return true; }
  return false;
}
</script>` +
    `</header>`
  );
}

function page(
  locale: Locale,
  active: PageActive,
  title: string,
  body: string,
  model = getMarketRadar(),
  autoRefreshSec = 60,
  switchPath = active === "opportunities" ? "/opportunities" : active === "walrus" ? "/walrus" : active === "review" ? "/review" : "/",
  switchParams: Record<string, string> = {}
): string {
  return `<!doctype html>
<html lang="${locale === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#06111f;--bg2:#081827;--panel:rgba(13,25,42,.82);--panel2:rgba(10,19,32,.94);--line:rgba(149,174,205,.18);--line2:rgba(67,199,255,.34);--text:#eef6ff;--dim:#91a4bc;--muted:#607188;--cyan:#43c7ff;--violet:#8b7cf6;--lime:#9ae66e;--amber:#f4bd50;--red:#e76675;--mono:"SFMono-Regular","Roboto Mono","Cascadia Mono",monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;overflow-x:hidden;background:radial-gradient(circle at 70% 0%,rgba(67,199,255,.10),transparent 34%),linear-gradient(180deg,#06111f 0%,#071523 48%,#060b13 100%);color:var(--text);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;letter-spacing:0}
body.modal-open{overflow:hidden}
a{color:inherit;text-decoration:none}
.shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;border-right:1px solid var(--line);background:rgba(4,12,22,.82);backdrop-filter:blur(18px);padding:16px 12px;display:flex;flex-direction:column;gap:18px}
.brand{display:flex;align-items:center;gap:10px;padding:6px 8px}.brand-mark{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(135deg,var(--cyan),var(--violet));color:#06111f;font-weight:900;box-shadow:0 0 30px rgba(67,199,255,.22)}.brand strong{display:block;font-size:14px}.brand small{display:block;color:var(--dim);font-size:11px}
.side-nav{display:flex;flex-direction:column;gap:5px}.side-nav a{display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;color:var(--dim);border:1px solid transparent}.side-nav a span{width:20px;text-align:center;color:var(--cyan)}.side-nav a.active,.side-nav a:hover{color:var(--text);background:rgba(67,199,255,.10);border-color:var(--line2)}
.side-card{margin-top:auto;border:1px solid var(--line);border-radius:8px;padding:12px;background:rgba(13,25,42,.58);display:grid;gap:4px}.side-card span,.side-card small{color:var(--dim);font-size:12px}
.workspace{min-width:0;padding:0 22px 56px}.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;min-width:0;max-width:100%;padding:12px 0;background:linear-gradient(180deg,rgba(6,17,31,.98),rgba(6,17,31,.78));backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}
.search{flex:1;min-width:280px;max-width:520px}.search input[name=q]{width:100%;height:38px;border:1px solid var(--line);border-radius:9px;background:rgba(5,12,22,.82);color:var(--text);padding:0 14px;outline:none}.search input:focus{border-color:var(--line2);box-shadow:0 0 0 3px rgba(67,199,255,.08)}
.top-nav{display:flex;gap:6px}.top-nav a,.top-actions button,.lang-pill{height:34px;display:inline-flex;align-items:center;border:1px solid var(--line);background:rgba(14,24,39,.62);color:var(--text);border-radius:999px;padding:0 11px;font-size:12px;cursor:pointer}.top-nav a.active,.top-nav a:hover,.top-actions button:hover,.lang-pill:hover{border-color:var(--line2);box-shadow:inset 0 0 18px rgba(67,199,255,.08)}
.top-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-left:auto;min-width:0;max-width:100%;overflow:visible}.top-actions::-webkit-scrollbar,.side-nav::-webkit-scrollbar{height:0}.chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line);color:var(--dim);background:rgba(12,22,36,.52);white-space:nowrap}.chip.ok b{color:var(--lime)}.chip.warn b{color:var(--amber)}.chip.stale b{color:var(--red)}
.hero-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(340px,.55fr);gap:14px;margin-top:16px;min-width:0}.bento{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;min-width:0}.span4{grid-column:span 4}.span5{grid-column:span 5}.span6{grid-column:span 6}.span7{grid-column:span 7}.span8{grid-column:span 8}.span12{grid-column:span 12}
.panel,.card,.metric-card{min-width:0;background:linear-gradient(180deg,rgba(15,28,47,.88),rgba(8,18,31,.84));border:1px solid var(--line);border-radius:8px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 22px 60px rgba(0,0,0,.24)}.panel{padding:14px}.card{display:block;padding:13px}.card:hover{border-color:var(--line2);transform:translateY(-1px);transition:transform .16s ease,border-color .16s ease}
.hero-title{font-size:34px;line-height:1.08;font-weight:820;margin:0 0 8px}.hero-sub{color:var(--dim);margin:0;max-width:820px}.mini{display:flex;gap:9px;align-items:center;flex-wrap:wrap;color:var(--dim);font-size:12px}.muted-line{margin-top:8px;color:var(--muted);font-size:12px}.mono,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.metric-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px;margin:14px 0}.metric-card{min-height:84px;padding:12px}.metric-card .label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}.metric-card .value{font-family:var(--mono);font-size:22px;line-height:1.2;margin-top:8px}.metric-card .hint{font-size:11px;color:var(--muted);margin-top:4px}
.priority-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(330px,.7fr);gap:14px;margin-top:16px}.dayhead{margin:12px 0 8px;color:var(--dim);font-size:12px}.priority-list{display:grid;gap:10px}.priority-card{padding:11px}.sporttery-line{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);font-size:12px;color:var(--dim)}.brief-panel .brief-item{padding:10px 0}.brief-panel .brief-item:first-of-type{padding-top:0}.brief-panel .brief-tag{display:inline-block;margin-top:2px}.edge-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.compact-table td,.compact-table th{padding:6px 8px}.details-panel{margin-top:10px}.btn{height:32px;border:1px solid var(--line);background:rgba(14,24,39,.72);color:var(--text);border-radius:8px;padding:0 12px;font-size:12px;cursor:pointer}.btn.primary{background:rgba(67,199,255,.22);border-color:var(--line2);color:#fff;font-weight:750}.btn:disabled{opacity:.55;cursor:wait}textarea.prompt-box,pre.prompt-box{width:100%;background:rgba(5,12,22,.72);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px;font:12px/1.45 var(--mono);white-space:pre-wrap}textarea.prompt-box{min-height:150px;resize:vertical}pre.prompt-box{max-height:280px;overflow:auto}.analysis-card{margin-bottom:10px}.analysis-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.value-map{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}.value-map div{border:1px solid var(--line);border-radius:7px;padding:8px;background:rgba(5,12,22,.24)}
.plan-panel{margin-top:16px}.plan-card-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:start}.plan-card-actions{display:grid;gap:8px;justify-items:end;min-width:150px}.plan-modal-backdrop{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:20px;background:rgba(2,8,16,.72);backdrop-filter:blur(14px)}.plan-modal-backdrop[hidden]{display:none}.plan-modal{width:min(1120px,100%);max-height:calc(100vh - 40px);overflow:hidden;border:1px solid var(--line2);border-radius:8px;background:linear-gradient(180deg,rgba(13,25,42,.98),rgba(6,14,25,.98));box-shadow:0 28px 90px rgba(0,0,0,.5)}.plan-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}.plan-modal-head h2{margin-top:0}.plan-modal-body{max-height:calc(100vh - 132px);overflow:auto;padding:14px 16px}.icon-btn{width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--line);border-radius:8px;background:rgba(14,24,39,.72);color:var(--text);cursor:pointer;font-weight:800}.icon-btn:hover{border-color:var(--line2)}.plan-config{display:grid;grid-template-columns:repeat(7,minmax(112px,1fr));gap:9px;margin-top:4px}.plan-config.compact-config{grid-template-columns:repeat(2,minmax(150px,1fr));margin:8px 0 0}.plan-config label{display:grid;gap:4px;color:var(--dim);font-size:11px}.plan-config input,.plan-config select{height:34px;min-width:0;border:1px solid var(--line);border-radius:8px;background:rgba(5,12,22,.78);color:var(--text);padding:0 9px}.switch-row{height:34px;display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:8px;background:rgba(5,12,22,.54);padding:0 9px;color:var(--text)}.switch-row input{width:15px;height:15px;padding:0}.plan-advanced{margin-top:8px}.plan-advanced summary{color:var(--dim);font-size:12px;cursor:pointer}.plan-progress{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid rgba(244,189,80,.28);background:rgba(244,189,80,.09);border-radius:8px;padding:10px 12px;margin:10px 0;color:var(--amber)}.plan-progress[hidden]{display:none}.plan-progress span{color:var(--dim);font-size:12px}.plan-verdict{border:1px solid rgba(154,230,110,.22);background:rgba(154,230,110,.08);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-weight:760}.plan-summary{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:8px;margin:10px 0}.plan-summary div,.plan-empty{border:1px solid var(--line);border-radius:8px;background:rgba(5,12,22,.26);padding:10px}.plan-error pre{white-space:pre-wrap;margin:8px 0 0;color:var(--dim);font:12px/1.45 var(--mono)}.plan-summary span{display:block;color:var(--dim);font-size:11px}.plan-summary b{display:block;font-family:var(--mono);font-size:18px;margin-top:3px}.plan-section{margin-top:10px}.plan-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(190px,.28fr);gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}.plan-row:last-child{border-bottom:0}.plan-bucket{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}.plan-bucket h3{margin:0 0 8px;font-size:14px}.plan-bucket.good h3{color:var(--lime)}.plan-bucket.watch h3{color:var(--amber)}.plan-bucket.avoid h3{color:var(--red)}.plan-bet-card{display:grid;grid-template-columns:minmax(0,1fr) minmax(210px,.28fr);gap:12px;padding:12px;border:1px solid var(--line);border-radius:8px;background:rgba(5,12,22,.22);margin-bottom:8px}.plan-lite-row{border:1px solid var(--line);border-radius:8px;padding:9px 10px;background:rgba(5,12,22,.18);margin-bottom:7px}.plan-lite-row p{margin:4px 0;color:var(--dim);font-size:12px}.plan-lite-row span{color:var(--muted);font-size:12px}.plan-numbers{display:grid;gap:5px;align-content:start}.plan-numbers span{display:flex;justify-content:space-between;gap:8px;color:var(--dim);font-size:12px}.plan-numbers b{color:var(--text);font-family:var(--mono)}.plan-small{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)}
.section-head,.panel-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:22px 0 10px}.panel-head{margin:0 0 10px}h2{font-size:16px;margin:0}h2 small{color:var(--dim);font-weight:400;margin-left:8px}.section-head a{font-size:12px;color:var(--cyan)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}.card-head{display:flex;align-items:center;gap:10px;margin-bottom:9px}.teams{font-weight:750;font-size:15px;flex:1}.ko{font-size:12px;color:var(--dim)}.ko-stack{display:grid;gap:3px;min-width:86px}.ko-date{font-size:11px;color:var(--dim);white-space:nowrap}.count-pill{display:inline-flex;align-items:center;justify-content:center;min-height:20px;border:1px solid rgba(67,199,255,.24);border-radius:999px;padding:1px 7px;color:var(--cyan);background:rgba(67,199,255,.08);font:700 11px/1.2 var(--mono)}.live{color:#fff;background:rgba(231,102,117,.82);border-radius:4px;padding:1px 6px;font-size:10px;font-weight:800}
.prob-bar{display:flex;height:10px;overflow:hidden;border-radius:999px;background:rgba(149,174,205,.14);margin:8px 0}.prob-row{display:flex;gap:12px;color:var(--dim);font-size:12px;min-width:0}.prob-row b{color:var(--text)}.spark{margin-left:auto;min-width:0}.spark svg{display:block;max-width:100%;height:auto}
.badge{display:inline-flex;align-items:center;min-height:19px;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:750;border:1px solid transparent;margin-right:4px}.badge.bad{background:rgba(231,102,117,.15);color:var(--red);border-color:rgba(231,102,117,.18)}.badge.watch{background:rgba(244,189,80,.12);color:var(--amber);border-color:rgba(244,189,80,.20)}.badge.low{background:rgba(154,230,110,.11);color:var(--lime);border-color:rgba(154,230,110,.18)}.badge.info{background:rgba(67,199,255,.11);color:var(--cyan);border-color:rgba(67,199,255,.18)}.badge.mute{background:rgba(149,174,205,.10);color:var(--dim);border-color:rgba(149,174,205,.16)}
.score-ring{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;font-family:var(--mono);font-weight:850;background:conic-gradient(var(--cyan) calc(var(--score)*1%),rgba(149,174,205,.14) 0);position:relative;flex:0 0 auto}.score-ring:before{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--panel2)}.score-ring span{position:relative}
.source-diffs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0;color:var(--dim);font-size:11px}.source-diff{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:999px;padding:2px 6px;background:rgba(5,12,22,.22)}.source-diff b{color:var(--text);font-size:10px}.source-diff em{font-style:normal;font-family:var(--mono);font-size:10px}
.opp-row{display:grid;grid-template-columns:1.7fr .68fr .72fr .7fr .78fr .8fr .74fr .92fr;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}.opp-row:last-child{border-bottom:0}.probability-row{grid-template-columns:1.9fr .58fr .58fr .58fr .62fr .62fr .56fr}.opp-title{font-weight:760}.opp-note{font-size:12px;color:var(--dim);margin-top:4px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line)}th{color:var(--dim);font-weight:550;font-size:12px}td.num,th.num{text-align:right}.dim{color:var(--dim)}.pos{color:var(--lime)}.neg{color:var(--red)}
.ai-brief{position:fixed;right:22px;bottom:20px;width:344px;z-index:30}.ai-brief summary{list-style:none;display:flex;gap:8px;align-items:center;border:1px solid var(--line2);background:rgba(12,24,43,.94);border-radius:999px;padding:10px 12px;box-shadow:0 18px 50px rgba(0,0,0,.30);cursor:pointer}.ai-brief summary::-webkit-details-marker{display:none}.spark-dot{width:9px;height:9px;border-radius:50%;background:var(--cyan);box-shadow:0 0 16px var(--cyan)}.brief-list{margin-top:10px;background:rgba(8,17,30,.96);border:1px solid var(--line);border-radius:8px;padding:8px;backdrop-filter:blur(18px)}.brief-item{padding:9px;border-bottom:1px solid var(--line);position:relative}.brief-item:last-child{border-bottom:0}.brief-item p{margin:4px 0;color:var(--dim);font-size:12px}.brief-tag{font-size:11px;color:var(--cyan)}
.proof-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.proof-grid div{border:1px solid var(--line);border-radius:7px;padding:9px;background:rgba(5,12,22,.28)}.proof-grid span{display:block;color:var(--dim);font-size:11px}.proof-grid b{display:block;margin-top:4px;font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis}.proof-blob{grid-column:1/-1}
.match-hero{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:18px;padding:18px;background:linear-gradient(135deg,rgba(67,199,255,.09),rgba(139,124,246,.09)),linear-gradient(180deg,rgba(15,28,47,.9),rgba(8,18,31,.86));border:1px solid var(--line);border-radius:8px}.team-badge{display:flex;align-items:center;gap:12px}.team-badge.away{justify-content:flex-end}.team-badge span{width:58px;height:58px;border-radius:50%;display:grid;place-items:center;font-family:var(--mono);font-weight:900;border:1px solid var(--line2);background:rgba(67,199,255,.10);color:var(--text)}.team-badge.away span{background:rgba(139,124,246,.12)}.team-badge b{font-size:20px}.countdown{text-align:center}.countdown strong{display:block;font-family:var(--mono);font-size:25px}.meta-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:9px;margin-top:10px}.meta-grid div{border:1px solid var(--line);border-radius:7px;padding:8px;background:rgba(5,12,22,.24)}.meta-grid span{display:block;color:var(--dim);font-size:11px}.meta-grid b{display:block;margin-top:3px;font-size:12px}.review-scoreboard{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;border:1px solid var(--line2);border-radius:8px;background:rgba(67,199,255,.07);padding:12px;margin-bottom:10px}.review-scoreboard div{display:flex;align-items:baseline;gap:10px}.review-scoreboard div:last-child{justify-content:flex-end}.review-scoreboard span{color:var(--dim)}.review-scoreboard b{font:900 34px/1 var(--mono)}.review-scoreboard strong{color:var(--cyan);font-size:12px;text-align:center}.review-scoreboard.empty strong{max-width:520px;color:var(--dim);font-weight:550}.event-timeline{display:grid;gap:7px}.event-timeline.empty{border:1px solid var(--line);border-radius:8px;background:rgba(5,12,22,.24);padding:10px;color:var(--dim)}.event-item{display:grid;grid-template-columns:58px 46px minmax(0,1fr);gap:8px;align-items:center;border:1px solid var(--line);border-radius:8px;background:rgba(5,12,22,.18);padding:8px}.event-item.goal{border-color:rgba(244,189,80,.30);background:rgba(244,189,80,.07)}.event-item b{font-family:var(--mono);color:var(--amber)}.event-item p{margin:0;color:var(--dim);font-size:12px}
.risk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.risk-item{border:1px solid var(--line);border-radius:8px;background:rgba(5,12,22,.28);padding:10px}.risk-item .r-title{font-size:12px;color:var(--dim)}.risk-item .r-value{font-family:var(--mono);font-size:20px;margin:5px 0}
.chart-grid{display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:12px}.chart-cell{min-width:0;overflow:hidden}.chart-cell svg{display:block;width:100%;height:auto;max-width:100%}.chart-title{font-size:12px;color:var(--dim);margin-bottom:4px}.legend{display:flex;gap:14px;font-size:12px;color:var(--dim);margin:4px 0 10px;flex-wrap:wrap}.legend i{display:inline-block;width:14px;height:3px;margin-right:4px;vertical-align:middle}
footer{margin-top:28px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
@media (max-width:1180px){.shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;flex-direction:row;align-items:center;overflow-x:auto;min-width:0;max-width:100vw}.brand{flex:0 0 auto}.side-nav{flex:1 1 auto;min-width:0;overflow-x:auto;flex-direction:row}.side-nav a{flex:0 0 auto}.side-card{display:none}.workspace{padding:0 14px 48px}.metric-strip{grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}.hero-grid,.bento,.priority-grid{grid-template-columns:minmax(0,1fr)}.span4,.span5,.span6,.span7,.span8,.span12{grid-column:span 1}.topbar{flex-wrap:wrap}.top-actions{width:100%;overflow-x:auto}.chart-grid{grid-template-columns:1fr}.meta-grid{grid-template-columns:repeat(2,1fr)}.plan-config{grid-template-columns:repeat(3,minmax(0,1fr))}.plan-summary{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:760px){.cards{grid-template-columns:1fr}.metric-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.ai-prob-strip{grid-template-columns:1fr!important}.opp-row{grid-template-columns:1fr}.ai-brief{position:static;width:auto;margin-top:12px}.match-hero,.review-scoreboard{grid-template-columns:1fr;text-align:left}.team-badge.away,.review-scoreboard div:last-child{justify-content:flex-start}.countdown{text-align:left}.risk-grid,.proof-grid,.edge-grid,.analysis-grid,.value-map,.plan-card-grid,.plan-config,.plan-summary,.plan-row,.plan-bet-card{grid-template-columns:1fr}.plan-progress{display:grid}.plan-card-actions{justify-items:start}.plan-modal-backdrop{align-items:stretch;padding:10px}.plan-modal{max-height:calc(100vh - 20px)}.plan-modal-body{max-height:calc(100vh - 112px)}table{display:block;overflow-x:auto;white-space:nowrap;max-width:100%}.hero-title{font-size:27px}.search{min-width:100%;max-width:none}.top-nav{overflow-x:auto;max-width:100%}.top-actions{overflow:visible;flex-wrap:wrap;gap:6px}.prob-row{flex-wrap:wrap}.spark{width:100%;margin-left:0}.event-item{grid-template-columns:50px 42px minmax(0,1fr)}}
@media (max-width:520px){.metric-strip{grid-template-columns:1fr}.side-nav a b{display:none}.workspace{padding-left:12px;padding-right:12px}.top-actions{padding-bottom:2px}.chip,.lang-pill{height:30px;padding:0 8px}.team-badge span{width:48px;height:48px}.team-badge b{font-size:18px}}
</style>
</head>
<body>
<div class="shell">
${sidebar(locale, active)}
<div class="workspace">
${topbar(locale, active, model, switchPath, switchParams)}
${body}
</div>
</div>
<script>
(function(){
  function countdownText(el){
    if(el.dataset.live==="1") return ${JSON.stringify(locale === "zh" ? "进行中" : "Live")};
    var t=Date.parse(el.dataset.kickoff||"");
    if(!Number.isFinite(t)) return el.textContent || "";
    var diff=t-Date.now();
    if(diff < -2.5*3600*1000) return ${JSON.stringify(locale === "zh" ? "已结束" : "Completed")};
    if(diff <= 0) return ${JSON.stringify(locale === "zh" ? "进行中" : "Live")};
    var minutes=Math.floor(diff/60000);
    var days=Math.floor(minutes/1440);
    var hours=Math.floor((minutes%1440)/60);
    var mins=minutes%60;
    if(days>0) return ${JSON.stringify(locale === "zh" ? "" : "")} + (days + ${JSON.stringify(locale === "zh" ? "天 " : "d ")} + hours + ${JSON.stringify(locale === "zh" ? "小时" : "h")});
    if(hours>0) return hours + ${JSON.stringify(locale === "zh" ? "小时 " : "h ")} + mins + ${JSON.stringify(locale === "zh" ? "分" : "m")};
    return Math.max(0, mins) + ${JSON.stringify(locale === "zh" ? "分" : "m")};
  }
  function updateCountdowns(){
    document.querySelectorAll(".js-countdown").forEach(function(el){ el.textContent=countdownText(el); });
  }
  updateCountdowns();
  setInterval(updateCountdowns, 1000);
  var y=sessionStorage.getItem("y"); if(y) window.scrollTo(0, Number(y));
  function typing(){
    var el=document.activeElement;
    return el && ["INPUT","TEXTAREA","SELECT"].indexOf(el.tagName)>=0;
  }
  function schedule(){
    setTimeout(function(){
      if(window.__busy || window.__pauseAutoRefresh || typing()){ schedule(); return; }
      sessionStorage.setItem("y", String(window.scrollY)); location.reload();
    }, ${autoRefreshSec * 1000});
  }
  schedule();
})();
</script>
</body>
</html>`;
}

function insightCard(locale: Locale, match: MatchIntelligence): string {
  const row = match.row;
  const t = COPY[locale];
  const consensus = row.bookAvg ?? row.polymarket ?? row.kalshi ?? row.pinnacle;
  const kickoff = new Date(row.kickoffUtc);
  const ko = row.live ? `<span class="live">${esc(t.labels.live)}</span>` : `<span class="ko">${esc(clock(locale, kickoff))}</span>`;
  const probRow = consensus
    ? `<div class="prob-row">${LABELS.map((label) => `<span>${esc(outcomeName(locale, row, label))} <b>${pct(consensus[label])}</b></span>`).join("")}<span class="spark">${cardSpark(locale, row)}</span></div>`
    : `<div class="dim">${esc(t.labels.insufficient)}</div>`;
  return (
    `<a class="card" href="${href("/match", locale, { fk: row.fixtureKey })}">` +
    `<div class="card-head">${ko}<span class="teams">${esc(matchNameFromRow(locale, row))}</span>${scoreRing(match.heatScore, "heat")}</div>` +
    (consensus ? consensusBar(locale, row, consensus) + probRow : probRow) +
    `<div class="mini"><span>PM liquidity <b class="mono">${compactMoney(match.pmLiquidity)}</b></span><span>24h active traders <b class="mono">${compactNumber(match.pmActiveTraders24h)}</b>${match.sampled ? ` <span class="badge mute">${esc(t.labels.sampled)}</span>` : ""}</span><span>spread <b class="mono">${percent(match.pmAvgSpread, 1)}</b></span>${riskBadge(locale, match.riskLevel)}</div>` +
    `<div class="opp-note">${esc(explainMarket(locale, match.aiExplanation))}</div>` +
    `<div class="mini">${tagList(locale, match.tags, 5)}</div>` +
    `</a>`
  );
}

function opportunityTitle(locale: Locale, o: MarketOpportunity): string {
  if (o.outcome === "draw") return `${outcomeLabel(locale, "draw")} · ${marketTypeLabel(locale, o.marketType)}`;
  return `${team(locale, o.outcomeName)} · ${marketTypeLabel(locale, o.marketType)}`;
}

function opportunityRow(locale: Locale, o: MarketOpportunity, compact = false): string {
  const t = COPY[locale];
  const match = matchName(locale, o.homeTeam, o.awayTeam);
  const score = scoreRing(o.opportunityScore, t.labels.score);
  const sampled = o.sampled ? ` <span class="badge mute">${esc(t.labels.sampled)}</span>` : "";
  if (compact) {
    return (
      `<a class="card" href="${href("/match", locale, { fk: o.fixtureKey })}">` +
      `<div class="card-head"><span class="teams">${esc(opportunityTitle(locale, o))}<span class="opp-note">${esc(match)}</span></span>${score}</div>` +
      `<div class="mini"><span>${esc(t.labels.liq)} <b class="mono">${compactMoney(o.liquidity)}</b></span><span>${esc(t.labels.volume)} <b class="mono">${compactMoney(o.volume24h)}</b></span><span>${esc(t.labels.gap)} <b class="mono">${o.maxCrossPlatformProbabilityGap.toFixed(1)}pp</b></span>${riskBadge(locale, o.riskLevel)}</div>` +
      `<div class="opp-note">${esc(explainMarket(locale, o.aiExplanation))}</div><div class="mini">${tagList(locale, o.tags, 4)}<span class="badge info">${esc(ACTION_LABELS[locale][o.suggestedAction])}</span></div>` +
      `</a>`
    );
  }
  return (
    `<div class="opp-row">` +
    `<div><div class="opp-title"><a href="${href("/match", locale, { fk: o.fixtureKey })}">${esc(opportunityTitle(locale, o))}</a></div><div class="opp-note">${esc(match)} · ${esc(o.platform)} · ${esc(marketTypeLabel(locale, o.marketType))}</div><div class="opp-note">${esc(explainMarket(locale, o.aiExplanation))}</div></div>` +
    `<div class="num">${pct(o.currentPrice)}<div class="opp-note">${esc(t.labels.price)}</div></div>` +
    `<div class="num">${pct(o.marketImpliedProbability)}<div class="opp-note">${esc(t.labels.marketProb)}</div></div>` +
    `<div class="num">${Math.round(o.confidenceScore)}<div class="opp-note">${esc(t.labels.confidence)}</div></div>` +
    `<div class="num">${signedPp(o.probabilityGap)}pp<div class="opp-note">${esc(t.labels.gap)}</div></div>` +
    `<div class="num">${compactMoney(o.liquidity)}<div class="opp-note">${esc(t.labels.liq)}</div></div>` +
    `<div class="num">${compactNumber(o.activeTraders24h)}${sampled}<div class="opp-note">${esc(t.labels.traders)}</div></div>` +
    `<div style="display:flex;align-items:center;gap:10px;justify-content:flex-end">${score}<div>${riskBadge(locale, o.riskLevel)}<div class="opp-note">${esc(ACTION_LABELS[locale][o.suggestedAction])}</div></div></div>` +
    `<div class="mini" style="grid-column:1/-1">${tagList(locale, o.tags, 8)}<span>${esc(t.labels.volume)} ${compactMoney(o.volume24h)}</span><span>${esc(t.labels.spread)} ${percent(o.bidAskSpread, 1)}</span><span>${esc(t.labels.holderConc)} ${percent(o.topHolderConcentration)}</span><span>${esc(t.labels.close)} ${esc(fullTime(locale, new Date(o.closeTime)))}</span></div>` +
    `</div>`
  );
}

function compactOpportunityCards(locale: Locale, rows: MarketOpportunity[], empty: string): string {
  if (!rows.length) return `<div class="panel"><p class="dim">${esc(empty)}</p></div>`;
  return `<div class="cards">${rows.map((o) => opportunityRow(locale, o, true)).join("")}</div>`;
}

function riskPanel(locale: Locale, signals: RiskSignal[]): string {
  const t = COPY[locale];
  return `<div class="risk-grid">${signals
    .map(
      (s) =>
        `<div class="risk-item"><div class="r-title">${esc(RISK_SIGNAL_TITLES[locale][s.key])}</div><div class="r-value">${esc(s.value)}${s.sampled ? ` <span class="badge mute">${esc(t.labels.sampled)}</span>` : ""}</div>${riskBadge(locale, s.level)}<div class="opp-note">${esc(RISK_NOTES[locale][s.noteKey])}</div></div>`
    )
    .join("")}</div>`;
}

function marketMetricsTable(locale: Locale, match: MatchIntelligence): string {
  const t = COPY[locale];
  const rows = LABELS.map((label) => {
    const metric = match.pmMarkets[label];
    return (
      `<tr><td>${esc(outcomeName(locale, match.row, label))}</td>` +
      `<td class="num">${metric ? pct(metric.lastTradePrice) : "-"}</td>` +
      `<td class="num">${compactMoney(metric?.liquidity)}</td>` +
      `<td class="num">${compactMoney(metric?.volume24h)}</td>` +
      `<td class="num">${percent(metric?.spread, 1)}</td>` +
      `<td class="num">${compactNumber(metric?.activeTraders24h)}${metric?.tradesSampled ? ` <span class="badge mute">${esc(t.labels.sampled)}</span>` : ""}</td>` +
      `<td class="num">${compactNumber(metric?.holderDepthTop)}${metric?.holdersSampled ? ` <span class="badge mute">${esc(t.labels.topCap)}</span>` : ""}</td>` +
      `<td class="num">${percent(metric?.holderConcentration)}</td></tr>`
    );
  }).join("");
  return `<table><tr><th>PM market</th><th class="num">Last</th><th class="num">PM liquidity</th><th class="num">Volume 24h</th><th class="num">Spread</th><th class="num">Active traders 24h</th><th class="num">Top holder depth</th><th class="num">Top holder conc.</th></tr>${rows}</table>`;
}

function sourceTable(locale: Locale, row: CurrentOddsRow): string {
  const order = ["polymarket", "kalshi", "pinnacle", "sporttery"];
  const entries = Object.entries(row.sourceOdds).sort((a, b) => {
    const ia = order.indexOf(a[0]);
    const ib = order.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a[0].localeCompare(b[0]);
  });
  const diffCell = (label: Label, probs: ThreeWay): string => {
    if (!row.bookAvg) return `<td class="num">${pct(probs[label])}</td>`;
    const diff = (probs[label] - row.bookAvg[label]) * 100;
    const cls = diff >= 2 ? "neg" : diff <= -2 ? "pos" : "dim";
    return `<td class="num">${pct(probs[label])} <span class="${cls}" style="font-size:11px">${signedPp(diff)}</span></td>`;
  };
  const avgRow = row.bookAvg
    ? `<tr style="font-weight:650"><td>${locale === "zh" ? "书商中位" : "Book median"} (${row.books})</td>${LABELS.map((label) => `<td class="num">${pct(row.bookAvg![label])}</td>`).join("")}</tr>`
    : "";
  return `<table><tr><th>${locale === "zh" ? "平台" : "Platform"}</th>${LABELS.map((label) => `<th class="num">${esc(outcomeName(locale, row, label))}</th>`).join("")}</tr>${avgRow}${entries
    .map(([source, probs]) => `<tr><td>${esc(source)}</td>${LABELS.map((label) => diffCell(label, probs)).join("")}</tr>`)
    .join("")}</table>`;
}

function priorityMatchCard(locale: Locale, match: MatchIntelligence): string {
  const row = match.row;
  const t = COPY[locale];
  const consensus = row.bookAvg ?? row.polymarket ?? row.kalshi ?? row.pinnacle;
  const kickoff = new Date(row.kickoffUtc);
  const ko = matchTimePill(locale, row, kickoff);
  const probRow = consensus
    ? `<div class="prob-row">${LABELS.map((label) => `<span>${esc(outcomeName(locale, row, label))} <b>${pct(consensus[label])}</b></span>`).join("")}<span class="spark">${cardSpark(locale, row)}</span></div>`
    : `<div class="dim">${esc(t.labels.insufficient)}</div>`;
  return (
    `<a class="card priority-card" href="${href("/match", locale, { fk: row.fixtureKey })}">` +
    `<div class="card-head">${ko}<span class="teams">${esc(matchNameFromRow(locale, row))}</span>${scoreRing(match.heatScore, "heat")}</div>` +
    (consensus ? consensusBar(locale, row, consensus) + probRow : probRow) +
    (sourceDiffStrip(locale, row) || sportteryDiffLine(locale, row)) +
    `<div class="mini"><span>PM liq <b class="mono">${compactMoney(match.pmLiquidity)}</b></span><span>24h traders <b class="mono">${compactNumber(match.pmActiveTraders24h)}</b>${match.sampled ? ` <span class="badge mute">${esc(t.labels.sampled)}</span>` : ""}</span><span>${esc(t.labels.gap)} <b class="mono">${match.maxDivergencePp.toFixed(1)}pp</b></span>${riskBadge(locale, match.riskLevel)}</div>` +
    `</a>`
  );
}

function matchTimePill(locale: Locale, row: CurrentOddsRow, kickoff: Date): string {
  const live = row.live ? `<span class="live">${esc(COPY[locale].labels.live)}</span>` : "";
  return (
    `<span class="ko-stack">` +
    `<span class="ko-date">${esc(dayLabel(locale, row.kickoffUtc))} ${esc(clock(locale, kickoff))}</span>` +
    `<span class="count-pill js-countdown" data-kickoff="${esc(row.kickoffUtc)}" data-live="${row.live ? "1" : "0"}">${esc(countdown(locale, row))}</span>` +
    live +
    `</span>`
  );
}

function sourceDiffStrip(locale: Locale, row: CurrentOddsRow): string {
  if (!row.bookAvg) return "";
  const sources: [string, string][] = [
    ["pinnacle", "PIN"],
    ["polymarket", "PM"],
    ["kalshi", "KAL"],
    ["sporttery", locale === "zh" ? "体彩" : "SPT"],
  ];
  const items = sources
    .map(([source, label]) => {
      const probs = row.sourceOdds[source];
      if (!probs) return "";
      const diffs = LABELS.map((outcome) => {
        const diff = (probs[outcome] - row.bookAvg![outcome]) * 100;
        const cls = Math.abs(diff) < 1 ? "dim" : diff > 0 ? "pos" : "neg";
        return `<em class="${cls}">${esc(outcomeLabel(locale, outcome).slice(0, 1))}${signedPp(diff)}</em>`;
      }).join("");
      return `<span class="source-diff"><b>${esc(label)}</b>${diffs}</span>`;
    })
    .filter(Boolean)
    .join("");
  return items ? `<div class="source-diffs"><span class="dim">${locale === "zh" ? "相对书商中位" : "vs book median"}</span>${items}</div>` : "";
}

function priorityMatches(locale: Locale, matches: MatchIntelligence[]): string {
  const now = Date.now();
  const horizon = now + CARD_WINDOW_H * 3600_000;
  const live = matches.filter((m) => m.row.live);
  const near = matches.filter((m) => !m.row.live && Date.parse(m.row.kickoffUtc) <= horizon);
  const far = matches.filter((m) => !m.row.live && Date.parse(m.row.kickoffUtc) > horizon);
  const groups = new Map<string, MatchIntelligence[]>();
  for (const match of near) {
    const key = dayLabel(locale, match.row.kickoffUtc);
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }
  const liveHtml = live.length
    ? `<div class="dayhead" style="color:var(--red);font-weight:750">${locale === "zh" ? "进行中 · 盘中概率" : "Live in-play odds"}</div><div class="priority-list">${live.map((m) => priorityMatchCard(locale, m)).join("")}</div>`
    : "";
  const nearHtml = [...groups.entries()]
    .map(([day, rows]) => `<div class="dayhead">${esc(day)}</div><div class="priority-list">${rows.map((m) => priorityMatchCard(locale, m)).join("")}</div>`)
    .join("") || `<p class="dim">${locale === "zh" ? "48 小时内没有待开赛比赛。" : "No upcoming matches within 48h."}</p>`;
  const farHtml = far.length
    ? `<details class="details-panel"><summary>${locale === "zh" ? `更远的比赛 ${far.length} 场` : `${far.length} later matches`}</summary><div class="panel" style="margin-top:8px"><table class="compact-table"><tr><th>${locale === "zh" ? "开球" : "Kickoff"}</th><th>${locale === "zh" ? "比赛" : "Match"}</th><th class="num">${locale === "zh" ? "共识" : "Consensus"}</th></tr>${far
        .slice(0, 24)
        .map((m) => `<tr><td>${esc(fullTime(locale, new Date(m.row.kickoffUtc)))}</td><td><a href="${href("/match", locale, { fk: m.row.fixtureKey })}">${esc(matchNameFromRow(locale, m.row))}</a></td><td class="num">${esc(formatThreeWayShort(m.row.bookAvg))}</td></tr>`)
        .join("")}</table></div></details>`
    : "";
  return liveHtml + nearHtml + farHtml;
}

function edgeMatch(locale: Locale, raw: string): string {
  const parts = raw.split(/\s+vs\.?\s+/i);
  return parts.length === 2 ? matchName(locale, parts[0], parts[1]) : raw;
}

function edgeOutcome(locale: Locale, raw: string): string {
  return raw === "draw" ? outcomeLabel(locale, "draw") : team(locale, raw);
}

function edgeTable(locale: Locale, rows: SportteryAvoidanceRow[], empty: string): string {
  if (!rows.length) return `<p class="dim">${esc(empty)}</p>`;
  const body = rows
    .slice(0, 10)
    .map(
      (r) =>
        `<tr><td>${esc(fullTime(locale, new Date(r.kickoffUtc)))}</td><td>${esc(edgeMatch(locale, r.match))}</td><td><b>${esc(edgeOutcome(locale, r.outcome))}</b></td>` +
        `<td class="num">${pct(r.sporttery)}</td><td class="num">${pct(r.bookAvg)}</td><td class="num ${r.diffPp > 0 ? "neg" : "pos"}">${signedPp(r.diffPp)}</td></tr>`
    )
    .join("");
  return `<table class="compact-table"><tr><th>${locale === "zh" ? "开球" : "Kickoff"}</th><th>${locale === "zh" ? "比赛" : "Match"}</th><th>${locale === "zh" ? "方向" : "Outcome"}</th><th class="num">Sporttery</th><th class="num">${locale === "zh" ? "书商中位" : "Book median"}</th><th class="num">pp</th></tr>${body}</table>`;
}

function edgePanels(locale: Locale, rows: CurrentOddsRow[]): string {
  const edges = getSportteryEdges(rows, { thresholdPp: DIFF_PP, minBooks: MIN_BOOKS });
  return (
    `<section class="span12"><div class="section-head"><h2>${locale === "zh" ? "体彩 vs 国际共识" : "Sporttery vs Market Consensus"}<small>${locale === "zh" ? `阈值 ${DIFF_PP}pp，书商 >=${MIN_BOOKS} 家` : `${DIFF_PP}pp threshold, ${MIN_BOOKS}+ books`}</small></h2></div>` +
    `<div class="edge-grid"><div class="panel"><div class="panel-head"><h2 style="color:var(--red)">${locale === "zh" ? "避坑" : "Avoid"}</h2></div>${edgeTable(locale, edges.avoid, locale === "zh" ? "当前没有显著偏高的方向。" : "No materially overpriced directions.")}</div>` +
    `<div class="panel"><div class="panel-head"><h2 style="color:var(--lime)">${locale === "zh" ? "相对划算" : "Relative Value"}</h2></div>${edgeTable(locale, edges.value, locale === "zh" ? "当前没有显著偏低的方向。" : "No materially underpriced directions.")}</div></div></section>`
  );
}

function contributionText(locale: Locale, item: SourceContribution): string {
  const label =
    item.source === "book_median"
      ? locale === "zh" ? "书商中位" : "book median"
      : item.source === "polymarket"
        ? "PM"
        : item.source === "kalshi"
          ? "Kalshi"
          : "Pinnacle";
  return `${label} ${pct(item.probability)} x ${(item.weight * 100).toFixed(0)}%`;
}

function probabilityModelPanel(locale: Locale, model: ReturnType<typeof getMarketRadar>, fixtureKey?: string): string {
  const result = getProbabilityCandidates(70, fixtureKey);
  const rowByFixture = new Map(model.matches.map((m) => [m.row.fixtureKey, m.row]));
  const rows = result.candidates
    .filter((candidate) => candidate.edgePp > 0 || candidate.expectedValuePct > 0)
    .slice(0, fixtureKey ? 9 : 10);
  const title = locale === "zh" ? "透明概率模型" : "Transparent Probability Model";
  const sub = locale === "zh" ? "fair probability 不使用目标平台自身价格" : "fair probability excludes the target platform price";
  const formula =
    locale === "zh"
      ? "Fair probability = 书商中位 0.50 x min(books/5,1) + Pinnacle 0.20 + PM 0.20 x confidence + Kalshi 0.10；体彩只作为可赔价格，不参与 fair probability。推荐分 = edge 45% + EV 25% + confidence 20% + source depth 10%。"
      : "Fair probability = book median 0.50 x min(books/5,1) + Pinnacle 0.20 + PM 0.20 x confidence + Kalshi 0.10; Sporttery is treated only as an offered price. Score = edge 45% + EV 25% + confidence 20% + source depth 10%.";
  if (!rows.length) {
    return (
      `<section class="span12"><div class="section-head"><h2>${title}<small>${sub}</small></h2></div>` +
      `<div class="panel"><p class="dim">${locale === "zh" ? "当前没有足够独立来源支撑的正向 edge 候选。" : "No positive-edge candidate has enough independent sources right now."}</p>` +
      `<details class="details-panel"><summary>${locale === "zh" ? "分数怎么算" : "How scores work"}</summary><p class="opp-note">${esc(formula)}</p></details></div></section>`
    );
  }
  const body = rows
    .map((candidate: ProbabilityCandidate) => {
      const row = rowByFixture.get(candidate.fixtureKey);
      const match = row ? matchNameFromRow(locale, row) : candidate.fixtureKey;
      const outcome = row ? outcomeName(locale, row, candidate.outcome) : candidate.outcome.toUpperCase();
      const contrib = candidate.sourceContributions.map((item) => contributionText(locale, item)).join(" · ");
      return (
        `<div class="opp-row probability-row">` +
        `<div><div class="opp-title"><a href="${href("/match", locale, { fk: candidate.fixtureKey })}">${esc(match)}</a> · ${esc(outcome)}</div>` +
        `<div class="opp-note">${esc(candidate.offeredOdd.platform)} @ ${candidate.offeredOdd.decimalOdds.toFixed(3)} · ${esc(candidate.offeredOdd.priceBasis)}</div>` +
        `<div class="opp-note">${esc(contrib)}</div></div>` +
        `<div class="num">${pct(candidate.fairProbability)}<div class="opp-note">fair</div></div>` +
        `<div class="num">${pct(candidate.marketImpliedProbability)}<div class="opp-note">market</div></div>` +
        `<div class="num ${candidate.edgePp >= 0 ? "pos" : "neg"}">${signedPp(candidate.edgePp)}pp<div class="opp-note">edge</div></div>` +
        `<div class="num ${candidate.expectedValuePct >= 0 ? "pos" : "neg"}">${pct(candidate.expectedValuePct)}<div class="opp-note">EV/stake</div></div>` +
        `<div class="num">${pct(candidate.kellyFraction)}<div class="opp-note">Kelly</div></div>` +
        `<div style="display:flex;justify-content:flex-end">${scoreRing(candidate.score, "probability score")}</div>` +
        `</div>`
      );
    })
    .join("");
  return (
    `<section class="span12"><div class="section-head"><h2>${title}<small>${sub}</small></h2><a href="/api/probability${fixtureKey ? `?fk=${encodeURIComponent(fixtureKey)}` : ""}">JSON</a></div>` +
    `<div class="panel">${body}<details class="details-panel"><summary>${locale === "zh" ? "分数怎么算" : "How scores work"}</summary><p class="opp-note">${esc(formula)}</p></details></div></section>`
  );
}

function hhadBoardPanel(locale: Locale): string {
  const rows = getAllSportteryHhad();
  if (!rows.length) return "";
  const tr = (r: HhadBoardRow): string =>
    `<tr><td>${esc(fullTime(locale, new Date(r.kickoffUtc)))}</td><td><a href="${href("/match", locale, { fk: r.fixtureKey })}">${esc(matchName(locale, r.homeTeam, r.awayTeam))}</a></td>` +
    `<td>${esc(hhadLineDesc(locale, r.goalLine, r.homeTeam))}</td><td class="num">${LABELS.map((label) => (r.sp[label] !== null ? r.sp[label]!.toFixed(2) : "-")).join(" / ")}</td>` +
    `<td class="num">${r.probs ? LABELS.map((label) => pct(r.probs![label])).join(" / ") : "-"}</td><td class="dim">${r.sourceUpdatedTs ? esc(fullTime(locale, new Date(r.sourceUpdatedTs))) : "-"}</td></tr>`;
  const header = `<tr><th>${locale === "zh" ? "开球" : "Kickoff"}</th><th>${locale === "zh" ? "比赛" : "Match"}</th><th>${locale === "zh" ? "盘口" : "Line"}</th><th class="num">SP</th><th class="num">${locale === "zh" ? "归一隐含" : "Normalized"}</th><th>${locale === "zh" ? "更新" : "Updated"}</th></tr>`;
  const rest = rows.slice(10);
  return (
    `<section class="span12"><div class="section-head"><h2>${locale === "zh" ? "体彩让球胜平负 HHAD" : "Sporttery HHAD"}<small>${locale === "zh" ? `共 ${rows.length} 场，仅展示不比价` : `${rows.length} matches, display only`}</small></h2></div>` +
    `<div class="panel"><table class="compact-table">${header}${rows.slice(0, 10).map(tr).join("")}</table>` +
    (rest.length ? `<details class="details-panel"><summary>${locale === "zh" ? `更多 ${rest.length} 场` : `${rest.length} more`}</summary><table class="compact-table">${header}${rest.map(tr).join("")}</table></details>` : "") +
    `</div></section>`
  );
}

function outrightPanel(locale: Locale): string {
  const rows = getOutrightBoard(10);
  if (!rows.length) return "";
  const delta = (v: number | null): string =>
    v === null ? `<span class="dim">-</span>` : `<span class="${v >= 0.05 ? "pos" : v <= -0.05 ? "neg" : "dim"}">${signedPp(v)}</span>`;
  const body = rows
    .map((r) => {
      const gapPp = r.pm !== null && r.kalshi !== null ? (r.pm - r.kalshi) * 100 : null;
      const gap = gapPp === null ? `<span class="dim">-</span>` : `<span class="${Math.abs(gapPp) >= 1.5 ? "neg" : "dim"}">${signedPp(gapPp)}</span>`;
      return `<tr><td>${esc(team(locale, r.team))}<span class="dim" style="margin-left:6px;font-size:11px">${esc(r.team)}</span></td><td class="num">${pct(r.pm)}</td><td class="num">${delta(r.pmDeltaPp)}</td><td class="num">${pct(r.kalshi)}</td><td class="num">${delta(r.kalshiDeltaPp)}</td><td class="num">${gap}</td></tr>`;
    })
    .join("");
  return `<section class="span6"><div class="section-head"><h2>${locale === "zh" ? "夺冠概率 Top 10" : "Outright Top 10"}<small>PM/Kalshi</small></h2></div><div class="panel"><table class="compact-table"><tr><th>${locale === "zh" ? "球队" : "Team"}</th><th class="num">PM</th><th class="num">Δ24h</th><th class="num">Kalshi</th><th class="num">Δ24h</th><th class="num">Gap</th></tr>${body}</table></div></section>`;
}

function alertsPanel(locale: Locale): string {
  const recent = listRecentAlerts(10);
  if (!recent.length) return "";
  const alertTitle = (title: string): string => {
    if (locale === "zh") return title;
    const jump = title.match(/^盘口突变\s+(.+?)\s+vs\s+(.+?)\((.+?)\):\s+(.+?)\s+([+-].*)$/);
    if (jump) {
      const [, home, away, state, outcome, rest] = jump;
      const stateLabel = state === "进行中" ? "live" : state;
      const outcomeLabelText = outcome === "主胜" ? "Home" : outcome === "客胜" ? "Away" : outcome === "平" ? "Draw" : outcome;
      return `Line move ${team(locale, home)} vs ${team(locale, away)} (${stateLabel}): ${outcomeLabelText} ${rest}`;
    }
    return title
      .replaceAll("盘口突变", "Line move")
      .replaceAll("进行中", "live")
      .replaceAll("主胜", "Home")
      .replaceAll("客胜", "Away")
      .replaceAll("平", "Draw");
  };
  const items = recent
    .map((alert) => `<div class="muted-line"><span class="mono">${esc(fullTime(locale, new Date(`${alert.ts}Z`)))}</span> <span class="badge mute">${esc(alert.kind)}</span> ${esc(alertTitle(alert.title))}</div>`)
    .join("");
  return `<section class="span6" id="alerts"><div class="section-head"><h2>${locale === "zh" ? "最近告警" : "Recent Alerts"}<small>24h ${countAlerts24h()}</small></h2></div><div class="panel">${items}</div></section>`;
}

function healthPanel(locale: Locale): string {
  const { checks, counts } = runHealthChecks();
  const items = checks
    .map((check) => {
      const cls = check.level === "pass" ? "low" : check.level === "warn" ? "watch" : "bad";
      return `<div class="muted-line"><span class="badge ${cls}">${check.level.toUpperCase()}</span>${esc(check.message)}</div>`;
    })
    .join("");
  return `<section class="span12"><details class="panel"><summary>${locale === "zh" ? "数据健康" : "Data Health"}: ${counts.pass} pass / ${counts.warn} warn / ${counts.fail} fail</summary><div style="margin-top:8px">${items}</div></details></section>`;
}

function briefPanel(locale: Locale, model: ReturnType<typeof getMarketRadar>, rows: CurrentOddsRow[]): string {
  const t = COPY[locale];
  const edges = getSportteryEdges(rows, { thresholdPp: DIFF_PP, minBooks: MIN_BOOKS });
  const topEdge = edges.value[0] ?? edges.avoid[0];
  const freshness = getSourceFreshness().map((f) => `${freshnessGroup(locale, f.group)} ${fmtAge(f.ageMs)}`).join(" · ");
  const signalItems = model.aiBrief.slice(0, 5).map((item) => {
    const match = localizeMatch(locale, item.match);
    const outcome = item.outcomeName && item.outcomeName !== "Draw" ? team(locale, item.outcomeName) : item.outcomeName === "Draw" ? outcomeLabel(locale, "draw") : undefined;
    return `<div class="brief-item"><div><b>${esc(briefTitle(locale, item))}</b>${riskBadge(locale, item.level)}</div><p>${esc(briefText(locale, item, match, outcome))}</p><span class="brief-tag">${esc(briefTag(locale, item))}</span></div>`;
  }).join("");
  const edgeText = topEdge
    ? `${edgeMatch(locale, topEdge.match)} · ${edgeOutcome(locale, topEdge.outcome)} ${signedPp(topEdge.diffPp)}pp`
    : locale === "zh" ? "体彩暂无显著偏离国际共识的方向。" : "No major Sporttery edge currently.";
  return (
    `<aside class="panel brief-panel" id="brief"><div class="panel-head"><h2>${esc(t.aiBrief)}</h2><span class="badge info">${esc(t.signals)}</span></div>` +
    signalItems +
    `<div class="brief-item"><div><b>${locale === "zh" ? "体彩边际" : "Sporttery Edge"}</b><span class="badge watch">${locale === "zh" ? "相对信号" : "relative"}</span></div><p>${esc(edgeText)}</p><span class="brief-tag">Sporttery vs book median</span></div>` +
    `<div class="brief-item"><div><b>${locale === "zh" ? "数据新鲜度" : "Freshness"}</b><span class="badge low">${locale === "zh" ? "已检查" : "checked"}</span></div><p>${esc(freshness)}</p><span class="brief-tag">${locale === "zh" ? "下一步: 点进 Top 机会或临近比赛生成单场 AI 简报" : "Next: open a top match and generate a match brief"}</span></div>` +
    `</aside>`
  );
}

export function boardPage(locale: Locale = "zh"): string {
  const model = getMarketRadar(70);
  const t = COPY[locale];
  const rows = model.matches.map((m) => m.row);
  const highLiquidity = model.opportunities.filter((o) => o.liquidity !== null).sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0)).slice(0, 6);
  const divergence = [...model.opportunities].sort((a, b) => b.maxCrossPlatformProbabilityGap - a.maxCrossPlatformProbabilityGap).slice(0, 4);
  const closingSoon = model.opportunities
    .filter((o) => {
      const h = (Date.parse(o.kickoffUtc) - Date.now()) / 3600_000;
      return h >= 0 && h <= 24;
    })
    .sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc))
    .slice(0, 4);
  const topOpps = model.opportunities.slice(0, 5);
  const alerts = countAlerts24h();
  const body =
    bettingPlanPanel(locale, model) +
    `<section class="priority-grid"><div class="panel"><div class="panel-head"><h2>${locale === "zh" ? "近期重点比赛" : "Priority Matches"}</h2><div class="mini">${alerts ? `<a class="chip stale" href="#alerts">Alerts <b>${alerts}</b></a>` : ""}<span class="chip">Sampled PM <b>${model.metrics.sampledMarkets}</b></span><span class="chip">${esc(t.metrics.opportunities)} <b>${model.metrics.aiOpportunityCount}</b></span></div></div>${priorityMatches(locale, model.matches)}</div>${briefPanel(locale, model, rows)}</section>` +
    metricStrip(locale, model) +
    `<div class="bento">` +
    edgePanels(locale, rows) +
    probabilityModelPanel(locale, model) +
    `<section class="span8"><div class="section-head"><h2>${esc(t.sections.topOpps)}<small>${esc(t.sections.topOppsSub)}</small></h2><a href="${href("/opportunities", locale)}">${esc(t.sections.fullRanking)} →</a></div><div class="panel">${topOpps.map((o) => opportunityRow(locale, o)).join("")}</div></section>` +
    `<section class="span4"><div class="section-head"><h2>${esc(t.sections.highLiquidity)}</h2></div><div class="panel">${highLiquidity.map((o) => opportunityRow(locale, o, true)).join("") || `<p class="dim">${esc(t.empty.liquidity)}</p>`}</div></section>` +
    `<section class="span6"><div class="section-head"><h2>${esc(t.sections.divergence)}<small>${esc(t.sections.divergenceSub)}</small></h2></div>${compactOpportunityCards(locale, divergence, t.empty.divergence)}</section>` +
    `<section class="span6"><div class="section-head"><h2>${esc(t.sections.closing)}<small>${esc(t.sections.closingSub)}</small></h2></div>${compactOpportunityCards(locale, closingSoon, t.empty.closing)}</section>` +
    hhadBoardPanel(locale) +
    outrightPanel(locale) +
    alertsPanel(locale) +
    healthPanel(locale) +
    `<section class="span12">${walrusProof(locale)}</section>` +
    `</div><footer>${esc(t.footer)}</footer>`;
  return page(locale, "home", t.heroTitle, body, model);
}

function readWalrusManifest(): Record<string, unknown> | null {
  const path = join(WALRUS_FEED_DIR, "manifest-latest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readWalrusJson(relativePath: string): Record<string, unknown> | null {
  const path = join(WALRUS_FEED_DIR, relativePath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function walrusBlobHref(blobId: string): string | null {
  const base = WALRUS_AGGREGATOR_URL.trim().replace(/\/+$/, "");
  return base ? `${base}/v1/blobs/${encodeURIComponent(blobId)}` : null;
}

function walrusManifestHref(): string | null {
  const blob = getMeta("walrus_latest_manifest_blob_id");
  return blob ? walrusBlobHref(blob) : null;
}

function walrusArtifactsTable(locale: Locale, manifest: Record<string, unknown> | null): string {
  const artifacts = Array.isArray(manifest?.artifacts) ? (manifest.artifacts as Record<string, unknown>[]) : [];
  if (!artifacts.length) return `<p class="dim">${locale === "zh" ? "本地 manifest 尚未生成。" : "No local manifest yet."}</p>`;
  const rows = artifacts
    .map((artifact) => {
      const walrus = artifact.walrus && typeof artifact.walrus === "object" ? (artifact.walrus as Record<string, unknown>) : {};
      const blob = typeof walrus.blob_id === "string" ? walrus.blob_id : "";
      const hrefBlob = blob ? walrusBlobHref(blob) : null;
      return (
        `<tr><td>${esc(String(artifact.relativePath ?? artifact.name ?? "-"))}</td>` +
        `<td class="num">${money(Number(artifact.bytes ?? 0), 0)}</td>` +
        `<td class="mono">${esc(String(artifact.sha256 ?? "-")).slice(0, 18)}</td>` +
        `<td class="mono">${hrefBlob ? `<a href="${esc(hrefBlob)}">${esc(blob.slice(0, 18))}</a>` : esc(blob ? blob.slice(0, 18) : "-")}</td>` +
        `<td>${hrefBlob ? `<a class="btn" href="${esc(hrefBlob)}">${locale === "zh" ? "打开数据" : "Open data"}</a>` : `<span class="dim">${locale === "zh" ? "未发布" : "Not published"}</span>`}</td></tr>`
      );
    })
    .join("");
  return `<table class="compact-table"><tr><th>Artifact</th><th class="num">Bytes</th><th>SHA-256</th><th>Blob</th><th>${locale === "zh" ? "动作" : "Action"}</th></tr>${rows}</table>`;
}

function walrusDataPreview(locale: Locale): string {
  const radar = readWalrusJson("radar-latest.json");
  const opportunitiesFile = readWalrusJson("opportunities-latest.json");
  const ai = readWalrusJson("ai-board-latest.json");
  if (!radar && !opportunitiesFile && !ai) {
    return `<p class="dim">${locale === "zh" ? "还没有本地 Walrus 数据预览。先运行 npm run export:walrus 或发布一次快照。" : "No local Walrus data preview yet. Run npm run export:walrus or publish a snapshot first."}</p>`;
  }

  const metrics = radar?.metrics && typeof radar.metrics === "object" ? (radar.metrics as Record<string, unknown>) : {};
  const metricCards = [
    [locale === "zh" ? "总市场" : "Total markets", compactNumber(Number(metrics.totalMarkets ?? 0))],
    ["PM liquidity", compactMoney(typeof metrics.pmLiquidity === "number" ? metrics.pmLiquidity : null)],
    ["24h volume", compactMoney(typeof metrics.pmVolume24h === "number" ? metrics.pmVolume24h : null)],
    [locale === "zh" ? "AI 机会" : "AI opportunities", compactNumber(Number(metrics.aiOpportunityCount ?? 0))],
    ["Sampled", compactNumber(Number(metrics.sampledMarkets ?? 0))],
  ]
    .map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
    .join("");

  const opportunities = Array.isArray(opportunitiesFile?.opportunities)
    ? (opportunitiesFile!.opportunities as Record<string, unknown>[])
    : Array.isArray(radar?.opportunities)
      ? (radar!.opportunities as Record<string, unknown>[])
      : [];
  const opportunityRows = opportunities.slice(0, 6).map((row) => {
    const match = String(row.match ?? `${row.home_team ?? "-"} vs ${row.away_team ?? "-"}`);
    const score = Number(row.opportunity_score ?? 0);
    return (
      `<tr><td>${esc(match)}</td><td>${esc(String(row.outcome ?? "-"))}</td><td>${esc(String(row.platform ?? "-"))}</td>` +
      `<td class="num">${Number.isFinite(score) ? Math.round(score) : "-"}</td><td>${esc(String(row.risk_level ?? "-"))}</td></tr>`
    );
  }).join("");

  const latestAnalysis = ai?.latest_analysis && typeof ai.latest_analysis === "object" ? (ai.latest_analysis as Record<string, unknown>) : null;
  const verdict = latestAnalysis?.verdict && typeof latestAnalysis.verdict === "object" ? (latestAnalysis.verdict as BoardBettingVerdict) : null;
  const digest = verdict
    ? latestBettingSummary(locale, verdict)
    : `<p class="dim">${locale === "zh" ? "Walrus AI digest 尚未生成。" : "Walrus AI digest has not been generated yet."}</p>`;

  return (
    `<div class="proof-grid">${metricCards}</div>` +
    `<div class="section-head"><h2>${locale === "zh" ? "Top 机会数据" : "Top opportunity data"}</h2></div>` +
    (opportunityRows ? `<table class="compact-table"><tr><th>Match</th><th>Outcome</th><th>Platform</th><th class="num">Score</th><th>Risk</th></tr>${opportunityRows}</table>` : `<p class="dim">${locale === "zh" ? "暂无机会数据。" : "No opportunity data yet."}</p>`) +
    `<div class="section-head"><h2>${locale === "zh" ? "AI 公共摘要" : "Public AI digest"}</h2></div>${digest}`
  );
}

function walrusLogPanel(locale: Locale): string {
  const logs = listWalrusPublishLog(12);
  if (!logs.length) return `<p class="dim">${locale === "zh" ? "还没有 Walrus 发布日志。" : "No Walrus publish logs yet."}</p>`;
  return `<table class="compact-table"><tr><th>${locale === "zh" ? "时间" : "Time"}</th><th>Status</th><th>Network</th><th class="num">Artifacts</th><th class="num">Bytes</th><th>Detail</th></tr>${logs
    .map((log) => {
      const cls = log.status === "success" ? "low" : "watch";
      return `<tr><td>${esc(fullTime(locale, new Date(`${log.ts}Z`)))}</td><td><span class="badge ${cls}">${esc(log.status)}</span></td><td>${esc(log.network ?? "-")}</td><td class="num">${log.artifact_count}</td><td class="num">${money(log.total_bytes, 0)}</td><td>${esc(log.detail ?? log.manifest_blob_id ?? "-")}</td></tr>`;
    })
    .join("")}</table>`;
}

export function walrusPage(locale: Locale = "zh"): string {
  const model = getMarketRadar(70);
  const manifest = readWalrusManifest();
  const generated = typeof manifest?.generated_at === "string" ? manifest.generated_at : getMeta("walrus_latest_published_at");
  const manifestHref = walrusManifestHref();
  const latest = latestBoardVerdict();
  const body =
    `<section class="panel" style="margin-top:16px"><div class="hero-title">Walrus Data</div><p class="hero-sub">${locale === "zh" ? "公开、可验证的市场快照。这里展示 latest manifest、artifact、blob、AI 公共摘要和发布日志；用户本金、下注金额、API key 不会进入 Walrus。" : "Public verifiable market snapshots. This page shows the latest manifest, artifacts, blobs, public AI summary, and publish logs; user bankroll, stake amounts, and API keys are not exported."}</p></section>` +
    `<section style="margin-top:14px">${walrusProof(locale)}</section>` +
    `<div class="bento" style="margin-top:14px">` +
    `<section class="span8 panel"><div class="panel-head"><h2>Manifest</h2><div class="mini"><span class="badge info">${esc(String(manifest?.schema_version ?? getMeta("walrus_latest_schema_version") ?? "-"))}</span>${manifestHref ? `<a class="btn" href="${esc(manifestHref)}">${locale === "zh" ? "打开 manifest JSON" : "Open manifest JSON"}</a>` : ""}<a class="btn" href="/api/walrus">${locale === "zh" ? "打开 /api/walrus" : "Open /api/walrus"}</a></div></div><div class="proof-grid"><div><span>${locale === "zh" ? "生成时间" : "Generated"}</span><b>${generated ? esc(fullTime(locale, new Date(generated))) : "-"}</b></div><div><span>Network</span><b>${esc(String(manifest?.network ?? getMeta("walrus_latest_network") ?? "testnet"))}</b></div><div><span>Artifacts</span><b>${Array.isArray(manifest?.artifacts) ? manifest.artifacts.length : getMeta("walrus_latest_artifact_count") ?? "-"}</b></div></div><div style="margin-top:12px">${walrusArtifactsTable(locale, manifest)}</div></section>` +
    `<section class="span4 panel"><div class="panel-head"><h2>${locale === "zh" ? "公共 AI 摘要" : "Public AI Digest"}</h2></div>${latest?.verdict ? latestBettingSummary(locale, latest.verdict) : `<p class="dim">${locale === "zh" ? "还没有公开 AI 摘要。" : "No public AI digest yet."}</p>`}</section>` +
    `<section class="span12 panel"><div class="panel-head"><h2>${locale === "zh" ? "数据预览" : "Data Preview"}</h2><span class="badge info">${locale === "zh" ? "本地 JSON" : "Local JSON"}</span></div>${walrusDataPreview(locale)}</section>` +
    `<section class="span12 panel"><div class="panel-head"><h2>${locale === "zh" ? "发布日志" : "Publish Log"}</h2></div>${walrusLogPanel(locale)}</section>` +
    `</div><footer>${esc(COPY[locale].footer)}</footer>`;
  return page(locale, "walrus", "Walrus Data · WC Radar", body, model, 120, "/walrus");
}

export function opportunitiesPage(locale: Locale = "zh"): string {
  const model = getMarketRadar(70);
  const t = COPY[locale];
  const body =
    `<section class="panel" style="margin-top:16px"><div class="hero-title">${esc(t.opportunities)}</div><p class="hero-sub">${locale === "zh" ? "单一风险调整评分，综合 Polymarket liquidity、24h volume、spread、top holder depth、active traders、跨平台赔率分歧和数据质量惩罚。" : "A single risk-adjusted ranking using real Polymarket liquidity, 24h volume, spread, top holder depth, active trader observations, cross-platform odds divergence, and data-quality penalties."}</p></section>` +
    metricStrip(locale, model) +
    `<section><div class="section-head"><h2>${esc(t.sections.ranking)}<small>${esc(t.sections.rankingSub)}</small></h2><span class="dim">${model.opportunities.length} ${esc(t.labels.rows)}</span></div><div class="panel">${model.opportunities.map((o) => opportunityRow(locale, o)).join("")}</div></section>` +
    walrusProof(locale) +
    `<footer>${esc(t.oppFooter)}</footer>`;
  return page(locale, "opportunities", `${t.opportunities} · WC Radar`, body, model);
}

function reviewMatchPanel(locale: Locale, row: CurrentOddsRow): string {
  const history = reviewHistory(row);
  const bundle = getMatchEventBundle(row.fixtureKey);
  const markers = reviewGoalMarkers(locale, row, bundle);
  const kickoff = new Date(row.kickoffUtc);
  const title = matchNameFromRow(locale, row);
  return (
    `<section class="panel review-panel">` +
    `<div class="panel-head"><h2><a href="${href("/match", locale, { fk: row.fixtureKey })}">${esc(title)}</a></h2><span class="badge ${bundle.result ? "low" : "mute"}">${bundle.result ? esc(resultStatusLabel(locale, bundle.result.status)) : locale === "zh" ? "已结束 inferred" : "Completed inferred"}</span></div>` +
    reviewScoreboard(locale, row, bundle) +
    `<div class="meta-grid review-meta"><div><span>${locale === "zh" ? "开赛" : "Kickoff"}</span><b>${esc(fullTime(locale, kickoff))} CST</b></div><div><span>${locale === "zh" ? "关键转折点" : "Key turn"}</span><b>${esc(reviewKeyTurn(locale, row, history, bundle))}</b></div><div><span>${locale === "zh" ? "PM 人话解释" : "PM plain read"}</span><b>${esc(reviewPmMove(locale, row, history, bundle))}</b></div><div><span>${locale === "zh" ? "进球时间轴" : "Goal timeline"}</span><b>${markers.length ? `${markers.length} ${locale === "zh" ? "个进球标记" : "goal markers"}` : locale === "zh" ? "暂无" : "None"}</b></div><div><span>${locale === "zh" ? "赛果来源" : "Result source"}</span><b>${esc(bundle.result?.source ?? (API_FOOTBALL_KEY ? "api_football pending" : "not configured"))}</b></div></div>` +
    `<div style="margin-top:12px">${reviewTimeline(locale, row, bundle)}</div>` +
    `<div style="margin-top:12px">${reviewTrendChart(locale, row, history, markers)}</div>` +
    `<details class="details-panel"><summary>${locale === "zh" ? "全部来源异常跳变" : "All source jumps"}</summary><div style="margin-top:8px">${reviewAllJumps(locale, history)}</div></details>` +
    `<details class="details-panel"><summary>${locale === "zh" ? "查看最新多源概率表" : "Latest multi-source probabilities"}</summary><div style="margin-top:8px">${sourceTable(locale, row)}</div></details>` +
    `</section>`
  );
}

export function reviewPage(locale: Locale = "zh"): string {
  const model = getMarketRadar(70);
  const rows = getCompletedOdds(24);
  const resultNote = API_FOOTBALL_KEY
    ? locale === "zh"
      ? "已启用赛果事件源；匹配到的比赛会显示比分、进球时间轴，并把进球标到赔率走势图上。"
      : "Result/event source is enabled; matched games show score, goal timeline, and goal markers on charts."
    : locale === "zh"
      ? "未配置 API_FOOTBALL_KEY 时，这里会清楚降级为赔率复盘；若 The Odds API scores 可用，则只补比分、不显示进球事件。"
      : "Without API_FOOTBALL_KEY this clearly degrades to odds review. The Odds API scores fallback can add score only, not events.";
  const body =
    `<section class="panel" style="margin-top:16px"><div class="hero-title">${locale === "zh" ? "赛后赔率复盘" : "Post-match Odds Review"}</div><p class="hero-sub">${locale === "zh" ? "按开赛前 24 小时到开赛后 2.5 小时固定窗口复盘 PM、Kalshi、体彩和书商概率变化；优先用比分和进球时间解释市场转折。" : "Review PM, Kalshi, Sporttery, and book probability movement from 24h before kickoff to 2.5h after kickoff, with score and goal timing when available."}</p><div class="muted-line">${esc(resultNote)}</div></section>` +
    `<section style="margin-top:14px;display:grid;gap:14px">${rows.length ? rows.map((row) => reviewMatchPanel(locale, row)).join("") : `<div class="panel"><p class="dim">${locale === "zh" ? "还没有 inferred completed matches。" : "No inferred completed matches yet."}</p></div>`}</section>` +
    `<footer>${esc(COPY[locale].footer)}</footer>`;
  return page(locale, "review", `${locale === "zh" ? "赛后复盘" : "Post-match Review"} · WC Radar`, body, model, 300, "/review");
}

function countdown(locale: Locale, row: CurrentOddsRow): string {
  const kickoff = Date.parse(row.kickoffUtc);
  const hoursTo = (kickoff - Date.now()) / 3600_000;
  if (row.live) return COPY[locale].labels.live;
  if (hoursTo >= 48) return locale === "zh" ? `${Math.round(hoursTo / 24)} 天` : `${Math.round(hoursTo / 24)}d`;
  return locale === "zh" ? `${Math.max(0, hoursTo).toFixed(1)} 小时` : `${Math.max(0, hoursTo).toFixed(1)}h`;
}

const LEAN_LABELS: Record<Locale, Record<AnalysisVerdict["lean"], string>> = {
  zh: { home: "主胜", draw: "平局", away: "客胜", no_bet: "不行动" },
  en: { home: "Home", draw: "Draw", away: "Away", no_bet: "No action" },
};

const CONF_LABELS: Record<Locale, Record<AnalysisVerdict["confidence"], string>> = {
  zh: { low: "低", medium: "中", high: "高" },
  en: { low: "Low", medium: "Medium", high: "High" },
};

function verdictOutcome(locale: Locale, row: CurrentOddsRow, lean: AnalysisVerdict["lean"]): string {
  if (lean === "home") return `${LEAN_LABELS[locale].home} (${team(locale, row.homeTeam)})`;
  if (lean === "away") return `${LEAN_LABELS[locale].away} (${team(locale, row.awayTeam)})`;
  return LEAN_LABELS[locale][lean];
}

function parseAnalysis(response: string): AnalysisVerdict | null {
  try {
    const parsed = JSON.parse(response) as AnalysisVerdict;
    return parsed && typeof parsed === "object" && typeof parsed.lean === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function listHtml(items: string[] | undefined): string {
  const rows = (items ?? []).filter(Boolean);
  return rows.length ? rows.map((item) => `<li>${esc(item)}</li>`).join("") : `<li class="dim">-</li>`;
}

function analysisCard(locale: Locale, row: CurrentOddsRow, analysis: AiAnalysisRow, isLatest = false): string {
  const verdict = parseAnalysis(analysis.response);
  const meta = `<div class="muted-line">#${analysis.id} · ${esc(analysis.model ?? "?")} · ${esc(fullTime(locale, new Date(`${analysis.ts}Z`)))}</div>`;
  if (!verdict) {
    return `<div class="panel analysis-card"><div class="dim">${locale === "zh" ? "原始输出未能解析为结构化结论" : "Raw output was not parsed as a verdict"}</div><pre class="prompt-box">${esc(analysis.response.slice(0, 2400))}</pre>${meta}</div>`;
  }
  const valueMap = (verdict.value_map ?? [])
    .slice(0, 3)
    .map((item) => `<div><b>${esc(item.outcome === "home" ? outcomeName(locale, row, "home") : item.outcome === "away" ? outcomeName(locale, row, "away") : item.outcome === "draw" ? outcomeLabel(locale, "draw") : LEAN_LABELS[locale].no_bet)}</b><div class="opp-note">${esc(item.take)}</div><p class="opp-note">${esc(item.reason)}</p></div>`)
    .join("");
  return (
    `<div class="panel analysis-card">` +
    `<div class="panel-head"><h2>${esc(verdict.brief_title || (isLatest ? COPY[locale].sections.matchSummary : "AI"))}</h2><span class="badge info">${esc(CONF_LABELS[locale][verdict.confidence] ?? verdict.confidence)}</span></div>` +
    `<div class="mini"><span>${locale === "zh" ? "倾向" : "Lean"} <b>${esc(verdictOutcome(locale, row, verdict.lean))}</b></span>${meta}</div>` +
    `<p class="hero-sub" style="margin-top:8px">${esc(verdict.summary_zh || verdict.market_read || "")}</p>` +
    (verdict.market_read ? `<p class="opp-note">${esc(verdict.market_read)}</p>` : "") +
    `<div class="analysis-grid"><div><div class="opp-title">${locale === "zh" ? "关键信号" : "Signals"}</div><ul>${listHtml(verdict.key_signals)}</ul></div><div><div class="opp-title">${locale === "zh" ? "风险" : "Risks"}</div><ul>${listHtml(verdict.risks)}</ul></div></div>` +
    (valueMap ? `<div class="value-map">${valueMap}</div>` : "") +
    `<div class="analysis-grid" style="margin-top:10px"><div><div class="opp-title">${locale === "zh" ? "体彩视角" : "Sporttery Take"}</div><p class="opp-note">${esc(verdict.sporttery_take ?? "-")}</p></div><div><div class="opp-title">${locale === "zh" ? "继续观察" : "Watch Triggers"}</div><ul>${listHtml(verdict.watch_triggers)}</ul></div></div>` +
    `<div class="muted-line">${locale === "zh" ? "数据质量" : "Data quality"}: ${esc(verdict.data_quality ?? "-")}</div>` +
    `<div class="muted-line">${locale === "zh" ? "下一步" : "Next action"}: ${esc(verdict.next_action ?? "-")}</div>` +
    `</div>`
  );
}

function providerMessage(locale: Locale): string {
  try {
    const provider = currentAiProvider();
    if (provider.keyReady) return `${provider.label} · ${provider.model}`;
    return `${provider.missingConfig ?? provider.requiredKeyName} ${locale === "zh" ? "未配置，请复制 prompt 手动使用。" : "is not configured. Copy the prompt instead."}`;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

function aiAnalysisPanel(locale: Locale, fixtureKey: string, row: CurrentOddsRow, matchIntel: MatchIntelligence | null): string {
  const context = buildMatchContext(fixtureKey);
  const systemPrompt = currentSystemPrompt();
  const history = listAnalyses(fixtureKey, 5);
  const keyReady = hasApiKey();
  const latest = history[0];
  const rest = history.slice(1);
  const promptOpen = keyReady || locale === "en" ? "" : " open";
  const contextSummary = matchIntel
    ? explainMarket(locale, matchIntel.aiExplanation)
    : locale === "zh"
      ? "市场指标采集后会生成更完整的上下文。"
      : "Market metrics will deepen the context after collection.";
  const promptBlock = context
    ? `<details${promptOpen}><summary>${locale === "zh" ? "查看/编辑 prompt（系统模板 + 数据上下文）" : "View/edit prompt"}</summary><div class="panel" style="margin-top:8px">` +
      `<div class="opp-title">${locale === "zh" ? "系统模板" : "System template"}</div><textarea id="ai-system" class="prompt-box">${esc(systemPrompt)}</textarea>` +
      `<div class="mini" style="margin:8px 0 12px"><button type="button" class="btn" onclick="aiSaveTemplate()">${locale === "zh" ? "保存模板" : "Save"}</button><button type="button" class="btn" onclick="aiResetTemplate()">${locale === "zh" ? "恢复默认" : "Reset"}</button><button type="button" class="btn" onclick="aiCopyPrompt()">${locale === "zh" ? "复制完整 prompt" : "Copy prompt"}</button><span id="ai-tpl-status" class="dim"></span></div>` +
      `<div class="opp-title">${locale === "zh" ? "数据上下文" : "Data context"}</div><pre id="ai-context" class="prompt-box">${esc(context.prompt)}</pre>` +
      `</div></details>`
    : `<p class="dim">${locale === "zh" ? "无法组装 AI 上下文。" : "Could not build AI context."}</p>`;
  const action = context
    ? keyReady
      ? `<button id="ai-go" type="button" class="btn primary" onclick="aiAnalyze()">${history.length ? (locale === "zh" ? "重新生成 AI 简报" : "Regenerate AI Brief") : (locale === "zh" ? "生成 AI 简报" : "Generate AI Brief")}</button><span id="ai-status" class="dim"></span>`
      : `<span class="badge watch">${esc(providerMessage(locale))}</span>`
    : "";
  const latestHtml = latest
    ? analysisCard(locale, row, latest, true)
    : `<div class="panel analysis-card"><div class="panel-head"><h2>${esc(COPY[locale].sections.matchSummary)}</h2><span class="badge mute">${locale === "zh" ? "未生成" : "Not generated"}</span></div><p class="hero-sub">${esc(contextSummary)}</p><div class="mini"><span>${esc(COPY[locale].labels.noFabrication)}</span>${row.bookAvg ? `<span>${esc(COPY[locale].labels.marketConsensus)} ${formatThreeWayShort(row.bookAvg)}</span>` : ""}</div></div>`;
  const historyHtml = rest.length
    ? `<details class="details-panel"><summary>${locale === "zh" ? `历史分析 ${rest.length} 条` : `${rest.length} prior analyses`}</summary>${rest.map((analysis) => analysisCard(locale, row, analysis)).join("")}</details>`
    : "";
  return (
    `<section id="ai" class="span8"><div class="section-head"><h2>${esc(COPY[locale].sections.matchSummary)}<small>${esc(providerMessage(locale))}</small></h2></div>` +
    latestHtml +
    `<div class="mini" style="margin:10px 0">${action}</div>` +
    promptBlock +
    historyHtml +
    `<script>
function aiBusy(b){ window.__busy = b; var btn=document.getElementById("ai-go"); if(btn) btn.disabled=b; }
async function aiAnalyze(){
  aiBusy(true);
  var status=document.getElementById("ai-status"); if(status) status.textContent=${JSON.stringify(locale === "zh" ? "分析中..." : "Analyzing...")};
  try{
    var res=await fetch("/api/analyze?fk="+encodeURIComponent(${JSON.stringify(fixtureKey)})+"&lang=${locale}",{method:"POST"});
    var data=await res.json();
    if(!res.ok) throw new Error(data.message || data.error || res.status);
    if(status) status.textContent=${JSON.stringify(locale === "zh" ? "完成，刷新中..." : "Done. Refreshing...")};
    sessionStorage.setItem("y", String(window.scrollY));
    location.reload();
  }catch(e){ if(status) status.textContent=(${JSON.stringify(locale === "zh" ? "失败: " : "Failed: ")}) + e.message; aiBusy(false); }
}
async function aiSaveTemplate(){
  var status=document.getElementById("ai-tpl-status");
  var res=await fetch("/api/template",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({template:document.getElementById("ai-system").value})});
  if(status) status.textContent=res.ok ? ${JSON.stringify(locale === "zh" ? "已保存" : "Saved")} : ${JSON.stringify(locale === "zh" ? "保存失败" : "Save failed")};
}
async function aiResetTemplate(){
  var status=document.getElementById("ai-tpl-status");
  var res=await fetch("/api/template",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reset:true})});
  if(res.ok){ var data=await res.json(); document.getElementById("ai-system").value=data.template; if(status) status.textContent=${JSON.stringify(locale === "zh" ? "已恢复默认" : "Reset")}; }
}
async function aiCopyPrompt(){
  var full=document.getElementById("ai-system").value + "\\n\\n---\\n\\n" + document.getElementById("ai-context").textContent;
  await navigator.clipboard.writeText(full);
  var status=document.getElementById("ai-tpl-status"); if(status) status.textContent=${JSON.stringify(locale === "zh" ? "已复制" : "Copied")};
}
</script></section>`
  );
}

export function matchPage(fixtureKey: string, locale: Locale = "zh"): string {
  const model = getMarketRadar(70);
  const t = COPY[locale];
  const matchIntel = model.matches.find((m) => m.row.fixtureKey === fixtureKey) ?? getMatchIntelligence(fixtureKey);
  const row = matchIntel?.row ?? getCurrentOdds(70).find((r) => r.fixtureKey === fixtureKey);
  if (!row) return page(locale, "match", "Match not found", `<section class="panel" style="margin-top:16px"><p class="dim">${esc(t.empty.matchNotFound)}</p></section>`, model);

  const kickoff = new Date(row.kickoffUtc);
  const hhad = getSportteryHhad(fixtureKey);

  const related =
    `<div class="bento">` +
    `<section class="span8 panel"><div class="panel-head"><h2>${esc(marketTypeLabel(locale, "match_winner"))}</h2></div>${matchIntel ? marketMetricsTable(locale, matchIntel) : `<p class="dim">${esc(t.empty.liquidity)}</p>`}</section>` +
    `<section class="span4 panel"><div class="panel-head"><h2>HHAD</h2></div>${hhad ? `<p>${esc(hhadLineDesc(locale, hhad.goalLine, row.homeTeam))}</p><div class="mini">${LABELS.map((label) => `<span>${esc(outcomeLabel(locale, label))} <b class="mono">${hhad.sp[label] !== null ? hhad.sp[label]!.toFixed(2) : "-"}</b></span>`).join("")}</div>${hhad.probs ? `<div class="opp-note">${esc(formatThreeWayShort(hhad.probs))}</div>` : ""}` : `<p class="dim">${esc(t.labels.insufficient)}</p>`}</section>` +
    `</div>`;

  const body =
    `<section style="margin-top:16px">` +
    `<div class="match-hero">${teamBadge(locale, row.homeTeam, "home")}<div class="countdown"><span class="dim">${esc(t.labels.countdown)}</span><strong>${esc(countdown(locale, row))}</strong>${row.live ? `<span class="live">${esc(t.labels.live)}</span>` : ""}</div>${teamBadge(locale, row.awayTeam, "away")}</div>` +
    `<div class="meta-grid"><div><span>${esc(t.labels.stage)}</span><b>${esc(t.labels.groupStage)}</b></div><div><span>${esc(t.labels.start)}</span><b>${esc(fullTime(locale, kickoff))} CST</b></div><div><span>${esc(t.labels.venue)}</span><b>${esc(t.labels.tbd)}</b></div><div><span>${esc(t.labels.status)}</span><b>${row.live ? esc(t.labels.live) : esc(countdown(locale, row))}</b></div><div><span>${esc(t.labels.fixture)}</span><b class="mono">${esc(row.fixtureKey)}</b></div></div>` +
    `</section>` +
    bettingPlanPanel(locale, model, fixtureKey) +
    `<section class="bento">${aiAnalysisPanel(locale, fixtureKey, row, matchIntel)}<section class="span4 panel"><div class="panel-head"><h2>${esc(t.sections.riskPanel)}</h2></div>${matchIntel ? riskPanel(locale, matchIntel.riskSignals) : `<p class="dim">${esc(t.labels.insufficient)}</p>`}</section></section>` +
    `<div class="bento">${matchEventsPanel(locale, row)}</div>` +
    `<div class="section-head"><h2>${esc(t.sections.sourceOdds)}</h2></div><div class="panel">${sourceTable(locale, row)}</div>` +
    `<div class="bento">${probabilityModelPanel(locale, model, fixtureKey)}</div>` +
    `<div class="section-head"><h2>${esc(t.sections.related)}</h2></div>${related}` +
    `<div class="section-head"><h2>${esc(t.sections.priceTrend)}</h2></div><div class="panel">${trendChart(locale, fixtureKey)}</div>` +
    walrusProof(locale) +
    `<footer>${esc(t.footer)}</footer>`;
  return page(locale, "match", `${matchNameFromRow(locale, row)} · WC Radar`, body, model, 120, "/match", { fk: fixtureKey });
}
