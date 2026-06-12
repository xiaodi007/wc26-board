// 决策 board 的服务端渲染。信息架构(自上而下):
//   新鲜度 chips → 比赛卡片流(共识条 + 体彩 diff + sparkline)→ 避坑/划算榜 → 夺冠 Top10 → health。
// 核心视觉信号:体彩三向概率与国际书商中位的差(pp),红=避坑(体彩隐含概率偏高)、绿=相对划算。
import { getCurrentOdds, LABELS, type CurrentOddsRow, type Label, type ThreeWay } from "../queries/currentOdds.js";
import { getSportteryEdges, type SportteryAvoidanceRow } from "../queries/sportteryAvoidance.js";
import { getOutrightBoard } from "../queries/outright.js";
import { fmtAge, getSourceFreshness, runHealthChecks } from "../queries/healthChecks.js";
import { getLineHistory, type SourceLineHistory } from "../queries/lineHistory.js";
import { getAllSportteryHhad, getSportteryHhad, type HhadBoardRow } from "../queries/hhad.js";
import { buildMatchContext } from "../ai/context.js";
import { currentSystemPrompt, hasApiKey, type AnalysisVerdict } from "../ai/analyze.js";
import { countAlerts24h, listAnalyses, listRecentAlerts, type AiAnalysisRow } from "../db.js";
import { zhTeamName } from "../teams.js";
import { lineChart, sparkline, type ChartSeries } from "./svg.js";

const DIFF_PP = 2; // 体彩 vs 共识的显著阈值(百分点)
const MIN_BOOKS = 5;
const CARD_WINDOW_H = 48; // 卡片流只展开未来 48h,更远的折叠成列表

const LABEL_ZH: Record<Label, string> = { home: "主胜", draw: "平", away: "客胜" };
const LABEL_COLOR: Record<Label, string> = { home: "var(--blue)", draw: "#6b7280", away: "#e08a3c" };
const SOURCE_COLOR: Record<string, string> = {
  polymarket: "var(--blue)",
  kalshi: "#b07cf7",
  pinnacle: "var(--green)",
  sporttery: "var(--amber)",
};

function esc(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? "-" : `${(v * 100).toFixed(digits)}%`;
}

function signedPp(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

const bjTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const bjDate = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", weekday: "short" });
const bjFull = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const bjDayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

function dayLabel(kickoffUtc: string): string {
  const key = bjDayKey.format(new Date(kickoffUtc));
  const today = bjDayKey.format(new Date());
  const tomorrow = bjDayKey.format(new Date(Date.now() + 86400_000));
  const date = bjDate.format(new Date(kickoffUtc));
  if (key === today) return `今天 ${date}`;
  if (key === tomorrow) return `明天 ${date}`;
  return date;
}

function teamZh(name: string): string {
  return zhTeamName(name) ?? name;
}

function matchZh(row: CurrentOddsRow): string {
  return `${teamZh(row.homeTeam)} vs ${teamZh(row.awayTeam)}`;
}

// ---------- 公共页面骨架 ----------

function page(title: string, body: string, autoRefreshSec = 60): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#0f1115;--card:#161a22;--line:#262b36;--text:#e6e9ef;--dim:#8b93a3;--green:#3fb47f;--red:#e5484d;--amber:#f0b429;--blue:#4f8cff;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;}
a{color:inherit;text-decoration:none}
main{max-width:1100px;margin:0 auto;padding:16px 20px 60px}
header.top{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);margin-bottom:16px}
header.top h1{font-size:18px;margin:0 12px 0 0}
.chip{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid var(--line);color:var(--dim)}
.chip b{font-weight:600}
.chip.ok b{color:var(--green)}.chip.warn b{color:var(--amber)}.chip.stale b{color:var(--red)}
h2{font-size:15px;margin:26px 0 10px;color:var(--text)}
h2 small{color:var(--dim);font-weight:400;margin-left:8px}
.dayhead{margin:18px 0 8px;font-size:13px;color:var(--dim)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:10px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card:hover{border-color:#3a4254}
.card .head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.card .ko{color:var(--dim);font-size:12px;min-width:38px}
.card .teams{font-weight:600;font-size:15px;flex:1}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line)}
.bar div{height:100%}
.probrow{display:flex;gap:14px;margin-top:4px;font-size:12px}
.probrow span b{font-weight:600}
.sprow{display:flex;gap:14px;align-items:baseline;margin-top:8px;font-size:12px;border-top:1px dashed var(--line);padding-top:7px}
.sprow .t{color:var(--dim)}
.badge{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;font-weight:600;margin-left:3px}
.badge.bad{background:rgba(229,72,77,.15);color:var(--red)}
.badge.good{background:rgba(63,180,127,.15);color:var(--green)}
.mini{margin-top:7px;color:var(--dim);font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:5px 10px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500;font-size:12px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--green)}.neg{color:var(--red)}.dim{color:var(--dim)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
@media (max-width:900px){.grid2{grid-template-columns:1fr}.cards{grid-template-columns:1fr}}
details{margin-top:10px}
summary{cursor:pointer;color:var(--dim)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
.legend{display:flex;gap:14px;font-size:12px;color:var(--dim);margin:6px 0}
.legend i{display:inline-block;width:14px;height:3px;vertical-align:middle;margin-right:4px}
footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
.hl td{background:rgba(240,180,41,.06)}
.btn{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 14px;font-size:13px;cursor:pointer}
.btn:hover{border-color:#3a4254}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600}
.btn:disabled{opacity:.5;cursor:wait}
.live-badge{display:inline-block;background:var(--red);color:#fff;border-radius:4px;font-size:10px;padding:0 6px;font-weight:700;vertical-align:middle;animation:livePulse 2s ease-in-out infinite}
@keyframes livePulse{50%{opacity:.55}}
</style>
</head>
<body>
<main>
${body}
</main>
<script>
(function(){
  var y=sessionStorage.getItem("y"); if(y) window.scrollTo(0, Number(y));
  function tick(){
    if (window.__busy) { setTimeout(tick, 15000); return; } // AI 生成中不打断
    sessionStorage.setItem("y", String(window.scrollY));
    location.reload();
  }
  setTimeout(tick, ${autoRefreshSec * 1000});
})();
</script>
</body>
</html>`;
}

function freshnessChips(): string {
  return getSourceFreshness()
    .map((f) => {
      const cls = f.ageMs === null || f.ageMs > f.staleMs ? "stale" : f.ageMs > f.staleMs / 2 ? "warn" : "ok";
      return `<span class="chip ${cls}">${esc(f.group)} <b>${fmtAge(f.ageMs)}</b></span>`;
    })
    .join(" ");
}

// ---------- 主页 ----------

function consensusBar(probs: ThreeWay): string {
  const seg = (label: Label): string =>
    `<div style="width:${(probs[label] * 100).toFixed(1)}%;background:${LABEL_COLOR[label]}" title="${LABEL_ZH[label]} ${pct(probs[label])}"></div>`;
  return `<div class="bar">${seg("home")}${seg("draw")}${seg("away")}</div>`;
}

function probRow(row: CurrentOddsRow, probs: ThreeWay): string {
  return (
    `<div class="probrow">` +
    LABELS.map((label) => {
      const name = label === "home" ? teamZh(row.homeTeam) : label === "away" ? teamZh(row.awayTeam) : "平";
      return `<span style="color:${LABEL_COLOR[label]}">${esc(name)} <b>${pct(probs[label])}</b></span>`;
    }).join("") +
    `<span class="dim" style="margin-left:auto">共识=${row.books} 家书商中位</span></div>`
  );
}

function diffBadge(diffPp: number): string {
  if (diffPp >= DIFF_PP) return `<span class="badge bad">${signedPp(diffPp)} 避坑</span>`;
  if (diffPp <= -DIFF_PP) return `<span class="badge good">${signedPp(diffPp)} 划算</span>`;
  return `<span class="dim" style="font-size:11px;margin-left:3px">${signedPp(diffPp)}</span>`;
}

function sportteryRow(row: CurrentOddsRow): string {
  if (row.live) return `<div class="sprow"><span class="t">体彩</span><span class="dim">已停售(比赛进行中)</span></div>`;
  if (!row.sporttery) return `<div class="sprow"><span class="t">体彩</span><span class="dim">未开售/未抓取</span></div>`;
  if (!row.bookAvg || row.books < MIN_BOOKS) {
    return `<div class="sprow"><span class="t">体彩</span>${LABELS.map((l) => `<span>${pct(row.sporttery![l])}</span>`).join("")}<span class="dim">书商样本不足,不比价</span></div>`;
  }
  const cells = LABELS.map((label) => {
    const diffPp = (row.sporttery![label] - row.bookAvg![label]) * 100;
    return `<span>${LABEL_ZH[label]} ${pct(row.sporttery![label])}${diffBadge(diffPp)}</span>`;
  }).join("");
  return `<div class="sprow"><span class="t">体彩</span>${cells}</div>`;
}

function cardSpark(row: CurrentOddsRow): string {
  const pm = getLineHistory(row.fixtureKey, { hours: 24, bucketMinutes: 30, sources: ["polymarket"] })[0];
  if (!pm || pm.points.length < 2) return sparkline([]);
  const values = pm.points.map((p) => p.probs.home);
  const jumpTs = new Set(pm.jumps.filter((j) => j.label === "home").map((j) => j.ts));
  const jumpIdx = pm.points.map((p, i) => (jumpTs.has(p.ts) ? i : -1)).filter((i) => i >= 0);
  return sparkline(values, { jumpIdx });
}

function matchCard(row: CurrentOddsRow): string {
  const consensus = row.bookAvg ?? row.polymarket ?? row.kalshi ?? row.pinnacle;
  const mini =
    `<div class="mini">` +
    `<span>主胜: PM ${pct(row.polymarket?.home ?? null)} · Kalshi ${pct(row.kalshi?.home ?? null)} · Pin ${pct(row.pinnacle?.home ?? null)}</span>` +
    `<span style="margin-left:auto">${cardSpark(row)}</span>` +
    `</div>`;
  const elapsedMin = Math.max(0, Math.round((Date.now() - Date.parse(row.kickoffUtc)) / 60000));
  const ko = row.live
    ? `<span class="live-badge">LIVE ${elapsedMin}'</span>`
    : `<span class="ko">${bjTime.format(new Date(row.kickoffUtc))}</span>`;
  return (
    `<a class="card" href="/match?fk=${encodeURIComponent(row.fixtureKey)}">` +
    `<div class="head">${ko}<span class="teams">${esc(matchZh(row))}</span><span class="dim" style="font-size:11px">详情 →</span></div>` +
    (consensus ? consensusBar(consensus) + probRow(row, consensus) : `<div class="dim">暂无报价</div>`) +
    sportteryRow(row) +
    mini +
    `</a>`
  );
}

function edgeTable(rows: SportteryAvoidanceRow[], empty: string): string {
  if (rows.length === 0) return `<p class="dim">${esc(empty)}</p>`;
  const body = rows
    .slice(0, 10)
    .map(
      (r) =>
        `<tr><td>${esc(bjFull.format(new Date(r.kickoffUtc)))}</td><td>${esc(r.match.split(/\s+vs\.?\s+/i).map(teamZh).join(" vs "))}</td><td><b>${esc(r.outcome === "draw" ? "平" : teamZh(r.outcome))}</b></td>` +
        `<td class="num">${pct(r.sporttery)}</td><td class="num">${pct(r.bookAvg)}</td>` +
        `<td class="num ${r.diffPp > 0 ? "neg" : "pos"}">${signedPp(r.diffPp)}</td></tr>`
    )
    .join("");
  return `<table><tr><th>开球(北京)</th><th>比赛</th><th>方向</th><th class="num">体彩</th><th class="num">书商中位</th><th class="num">差(pp)</th></tr>${body}</table>`;
}

function hhadBoardSection(): string {
  const rows = getAllSportteryHhad();
  if (!rows.length) return "";

  const tr = (r: HhadBoardRow): string =>
    `<tr><td>${esc(bjFull.format(new Date(r.kickoffUtc)))}</td>` +
    `<td><a href="/match?fk=${encodeURIComponent(r.fixtureKey)}">${esc(teamZh(r.homeTeam))} vs ${esc(teamZh(r.awayTeam))}</a></td>` +
    `<td>${hhadLineDesc(r.goalLine, r.homeTeam)}</td>` +
    `<td class="num">${LABELS.map((l) => (r.sp[l] !== null ? r.sp[l]!.toFixed(2) : "-")).join(" / ")}</td>` +
    `<td class="num">${r.probs ? LABELS.map((l) => pct(r.probs![l])).join(" / ") : "-"}</td>` +
    `<td class="dim">${r.sourceUpdatedTs ? esc(bjFull.format(new Date(r.sourceUpdatedTs))) : "-"}</td></tr>`;

  const header = `<tr><th>开球(北京)</th><th>比赛</th><th>盘口</th><th class="num">SP 让球胜/平/负</th><th class="num">归一隐含</th><th>官方更新</th></tr>`;
  const head = rows.slice(0, 10).map(tr).join("");
  const rest = rows.slice(10);
  const restHtml = rest.length
    ? `<details><summary>更多 ${rest.length} 场</summary><table>${header}${rest.map(tr).join("")}</table></details>`
    : "";

  return (
    `<h2>体彩让球胜平负(HHAD)<small>共 ${rows.length} 场;无国际让球盘参照,仅展示不比价</small></h2>` +
    `<div class="panel"><table>${header}${head}</table>${restHtml}</div>`
  );
}

function outrightSection(): string {
  const rows = getOutrightBoard(10);
  if (rows.length === 0) return "";
  const delta = (v: number | null): string =>
    v === null ? `<span class="dim">-</span>` : `<span class="${v >= 0.05 ? "pos" : v <= -0.05 ? "neg" : "dim"}">${signedPp(v)}</span>`;
  const body = rows
    .map((r) => {
      const gapPp = r.pm !== null && r.kalshi !== null ? (r.pm - r.kalshi) * 100 : null;
      const gap =
        gapPp === null
          ? `<span class="dim">-</span>`
          : `<span class="${Math.abs(gapPp) >= 1.5 ? "neg" : "dim"}">${signedPp(gapPp)}</span>`;
      return (
        `<tr><td>${esc(teamZh(r.team))}<span class="dim" style="margin-left:6px;font-size:11px">${esc(r.team)}</span></td>` +
        `<td class="num">${pct(r.pm)}</td><td class="num">${delta(r.pmDeltaPp)}</td>` +
        `<td class="num">${pct(r.kalshi)}</td><td class="num">${delta(r.kalshiDeltaPp)}</td><td class="num">${gap}</td></tr>`
      );
    })
    .join("");
  return (
    `<h2>夺冠概率 Top 10 <small>两个预测市场互证;分歧 ≥1.5pp 标红</small></h2><div class="panel">` +
    `<table><tr><th>球队</th><th class="num">Polymarket</th><th class="num">Δ24h</th><th class="num">Kalshi</th><th class="num">Δ24h</th><th class="num">PM−Kalshi</th></tr>${body}</table></div>`
  );
}

function alertsSection(): string {
  const recent = listRecentAlerts(10);
  if (!recent.length) return "";
  const items = recent
    .map(
      (a) =>
        `<div style="font-size:12px;padding:2px 0"><span class="dim">${esc(bjFull.format(new Date(a.ts + "Z")))}</span> · <span class="chip" style="font-size:11px">${esc(a.kind)}</span> ${esc(a.title)}</div>`
    )
    .join("");
  return (
    `<details id="alerts"><summary>最近告警(24h 内 ${countAlerts24h()} 条;微信推送走 Server酱,合并+日上限)</summary>` +
    `<div class="panel" style="margin-top:8px">${items}</div></details>`
  );
}

function healthSection(): string {
  const { checks, counts } = runHealthChecks();
  const items = checks
    .map((c) => {
      const color = c.level === "pass" ? "var(--green)" : c.level === "warn" ? "var(--amber)" : "var(--red)";
      return `<div style="font-size:12px;padding:2px 0"><b style="color:${color}">${c.level.toUpperCase()}</b> <span class="dim">${esc(c.message)}</span></div>`;
    })
    .join("");
  return (
    `<details><summary>数据健康:${counts.pass} pass / ${counts.warn} warn / ${counts.fail} fail</summary>` +
    `<div class="panel" style="margin-top:8px">${items}</div></details>`
  );
}

export function boardPage(): string {
  const all = getCurrentOdds(50);
  const now = Date.now();
  const horizon = now + CARD_WINDOW_H * 3600_000;
  const liveRows = all.filter((r) => r.live);
  const near = all.filter((r) => !r.live && Date.parse(r.kickoffUtc) <= horizon);
  const far = all.filter((r) => !r.live && Date.parse(r.kickoffUtc) > horizon);

  const liveSection = liveRows.length
    ? `<div class="dayhead" style="color:var(--red);font-weight:600">进行中 · 盘中实时概率(体彩已停售)</div><div class="cards">${liveRows
        .map(matchCard)
        .join("")}</div>`
    : "";

  let cards = "";
  let lastDay = "";
  for (const row of near) {
    const day = dayLabel(row.kickoffUtc);
    if (day !== lastDay) {
      cards += `${lastDay ? "</div>" : ""}<div class="dayhead">${esc(day)}</div><div class="cards">`;
      lastDay = day;
    }
    cards += matchCard(row);
  }
  if (lastDay) cards += "</div>";
  if (!near.length) cards = `<p class="dim">48 小时内没有待开赛的比赛。</p>`;

  const farList = far.length
    ? `<details><summary>更远的比赛(${far.length} 场)</summary><div class="panel" style="margin-top:8px"><table>` +
      far
        .map(
          (r) =>
            `<tr><td>${esc(bjFull.format(new Date(r.kickoffUtc)))}</td><td><a href="/match?fk=${encodeURIComponent(r.fixtureKey)}">${esc(matchZh(r))}</a></td>` +
            `<td class="num">${r.bookAvg ? pct(r.bookAvg.home) + " / " + pct(r.bookAvg.draw) + " / " + pct(r.bookAvg.away) : "-"}</td></tr>`
        )
        .join("") +
      `</table></div></details>`
    : "";

  const edges = getSportteryEdges(all, { thresholdPp: DIFF_PP, minBooks: MIN_BOOKS });
  const edgeSection =
    `<h2>体彩 vs 国际共识 <small>阈值 ${DIFF_PP}pp,书商 ≥${MIN_BOOKS} 家;相对信号,非投注建议</small></h2>` +
    `<div class="grid2"><div class="panel"><h2 style="margin:0 0 8px;color:var(--red)">避坑(体彩隐含概率偏高)</h2>${edgeTable(edges.avoid, "当前没有显著偏高的方向")}</div>` +
    `<div class="panel"><h2 style="margin:0 0 8px;color:var(--green)">相对划算(体彩赔率偏高)</h2>${edgeTable(edges.value, "当前没有显著偏低的方向")}</div></div>`;

  const alerts24h = countAlerts24h();
  const alertChip = alerts24h
    ? `<a class="chip" href="#alerts" style="border-color:var(--red)">告警 <b style="color:var(--red)">${alerts24h}</b></a>`
    : "";

  const body =
    `<header class="top"><h1>WC26 Board</h1>${freshnessChips()}${alertChip}<span class="chip">北京时间 <b>${esc(bjFull.format(new Date()))}</b></span></header>` +
    liveSection +
    cards +
    farList +
    edgeSection +
    hhadBoardSection() +
    outrightSection() +
    alertsSection() +
    healthSection() +
    `<footer>纯本地只读聚合,个人参考,不构成投注建议。体彩数据为手动低频抓取,以官方实时 SP 为准。</footer>`;

  return page("WC26 Board", body);
}

// ---------- 详情页 ----------

function sourceTable(row: CurrentOddsRow): string {
  const order = ["sporttery", "polymarket", "kalshi", "pinnacle"];
  const entries = Object.entries(row.sourceOdds).sort((a, b) => {
    const ia = order.indexOf(a[0]);
    const ib = order.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a[0].localeCompare(b[0]);
  });

  const diffCell = (label: Label, probs: ThreeWay): string => {
    if (!row.bookAvg) return `<td class="num">${pct(probs[label])}</td>`;
    const diffPp = (probs[label] - row.bookAvg[label]) * 100;
    const cls = diffPp >= DIFF_PP ? "neg" : diffPp <= -DIFF_PP ? "pos" : "dim";
    return `<td class="num">${pct(probs[label])} <span class="${cls}" style="font-size:11px">${signedPp(diffPp)}</span></td>`;
  };

  const rows = entries
    .map(([source, probs]) => {
      const hl = source === "sporttery" ? ` class="hl"` : "";
      return `<tr${hl}><td>${esc(source)}</td>${LABELS.map((l) => diffCell(l, probs)).join("")}</tr>`;
    })
    .join("");
  const avgRow = row.bookAvg
    ? `<tr style="font-weight:600"><td>书商中位(${row.books})</td>${LABELS.map((l) => `<td class="num">${pct(row.bookAvg![l])}</td>`).join("")}</tr>`
    : "";
  return `<table><tr><th>源</th><th class="num">主胜</th><th class="num">平</th><th class="num">客胜</th></tr>${avgRow}${rows}</table>`;
}

function historyCharts(fixtureKey: string): string {
  const history = getLineHistory(fixtureKey, { hours: 48, bucketMinutes: 15 });
  const drawnSources = history.filter((s) => SOURCE_COLOR[s.source] && s.points.length > 0);
  if (drawnSources.length === 0) return `<p class="dim">暂无走势数据(daemon 需要积累几轮)。</p>`;

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
    return `<div><div class="dim" style="font-size:12px;margin-bottom:2px">${LABEL_ZH[label]}</div>${lineChart(series, { tMin, tMax })}</div>`;
  };

  const legend =
    `<div class="legend">` +
    drawnSources
      .map((s) => `<span><i style="background:${SOURCE_COLOR[s.source]}"></i>${esc(s.source)}</span>`)
      .join("") +
    `</div>`;

  const jumps = drawnSources
    .flatMap((s) => s.jumps.map((j) => ({ ...j, source: s.source })))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 12);
  const jumpList = jumps.length
    ? `<div style="margin-top:10px"><div class="dim" style="font-size:12px;margin-bottom:4px">盘口异动(单步 ≥2pp)</div>` +
      jumps
        .map(
          (j) =>
            `<div style="font-size:12px">${esc(bjFull.format(new Date(j.ts)))} · ${esc(j.source)} · ${LABEL_ZH[j.label]} <b class="${j.deltaPp > 0 ? "pos" : "neg"}">${signedPp(j.deltaPp)}pp</b></div>`
        )
        .join("") +
      `</div>`
    : "";

  return legend + `<div class="grid3">${chart("home")}${chart("draw")}${chart("away")}</div>` + jumpList;
}

function hhadLineDesc(goalLine: string, homeTeam: string): string {
  const line = Number(goalLine);
  if (!Number.isFinite(line)) return esc(goalLine);
  if (line < 0) return `${teamZh(homeTeam)} 让 ${Math.abs(line)} 球`;
  if (line > 0) return `${teamZh(homeTeam)} 受让 ${line} 球`;
  return "平手盘";
}

function hhadSection(fixtureKey: string, row: CurrentOddsRow): string {
  const hhad = getSportteryHhad(fixtureKey);
  if (!hhad) return "";
  const lineDesc = hhadLineDesc(hhad.goalLine, row.homeTeam);
  const cells = LABELS.map(
    (l) =>
      `<td class="num">${hhad.sp[l] !== null ? hhad.sp[l]!.toFixed(2) : "-"}<span class="dim" style="font-size:11px;margin-left:4px">${hhad.probs ? pct(hhad.probs[l]) : "-"}</span></td>`
  ).join("");
  return (
    `<h2>体彩让球胜平负(HHAD)<small>${lineDesc}${hhad.sourceUpdatedTs ? ` · 官方更新 ${esc(bjFull.format(new Date(hhad.sourceUpdatedTs)))}` : ""}</small></h2>` +
    `<div class="panel"><table><tr><th class="num">让球主胜 SP(隐含)</th><th class="num">让球平 SP</th><th class="num">让球客胜 SP</th></tr><tr>${cells}</tr></table></div>`
  );
}

// ---------- AI 分析面板 ----------

const LEAN_ZH: Record<AnalysisVerdict["lean"], string> = { home: "主胜", draw: "平局", away: "客胜", no_bet: "不下注" };
const CONF_ZH: Record<AnalysisVerdict["confidence"], string> = { low: "低", medium: "中", high: "高" };

function verdictCard(row: CurrentOddsRow, analysis: AiAnalysisRow): string {
  let verdict: AnalysisVerdict | null = null;
  try {
    verdict = JSON.parse(analysis.response) as AnalysisVerdict;
  } catch {
    /* 解析失败(refusal/截断)走 raw 展示 */
  }
  const meta = `<div class="dim" style="font-size:11px;margin-top:8px">#${analysis.id} · ${esc(analysis.model ?? "?")} · ${esc(bjFull.format(new Date(analysis.ts + "Z")))}</div>`;
  if (!verdict || !verdict.lean) {
    return `<div class="panel" style="margin-bottom:10px"><div class="dim">原始输出(未能解析为结构化结论):</div><pre style="white-space:pre-wrap;font-size:12px">${esc(analysis.response.slice(0, 2000))}</pre>${meta}</div>`;
  }
  const leanTeam =
    verdict.lean === "home" ? `(${teamZh(row.homeTeam)})` : verdict.lean === "away" ? `(${teamZh(row.awayTeam)})` : "";
  const leanColor = verdict.lean === "no_bet" ? "var(--dim)" : "var(--amber)";
  const list = (items: string[]): string => items.map((s) => `<li>${esc(s)}</li>`).join("");
  return (
    `<div class="panel" style="margin-bottom:10px">` +
    `<div style="font-size:15px"><b style="color:${leanColor}">倾向:${LEAN_ZH[verdict.lean]}${esc(leanTeam)}</b>` +
    `<span class="chip" style="margin-left:10px">信心 <b>${CONF_ZH[verdict.confidence] ?? esc(String(verdict.confidence))}</b></span></div>` +
    `<p style="margin:8px 0">${esc(verdict.summary_zh ?? "")}</p>` +
    `<div class="grid2"><div><div class="dim" style="font-size:12px">关键信号</div><ul style="margin:4px 0;padding-left:18px;font-size:13px">${list(verdict.key_signals ?? [])}</ul></div>` +
    `<div><div class="dim" style="font-size:12px">风险</div><ul style="margin:4px 0;padding-left:18px;font-size:13px">${list(verdict.risks ?? [])}</ul></div></div>` +
    `<div style="margin-top:6px;font-size:13px"><span class="dim">体彩视角:</span>${esc(verdict.sporttery_take ?? "")}</div>` +
    meta +
    `</div>`
  );
}

function aiSection(fixtureKey: string, row: CurrentOddsRow): string {
  const context = buildMatchContext(fixtureKey);
  const systemPrompt = currentSystemPrompt();
  const keyReady = hasApiKey();
  const history = listAnalyses(fixtureKey, 5);

  const historyHtml = history.length
    ? history.map((a) => verdictCard(row, a)).join("")
    : `<p class="dim">还没有分析记录。</p>`;

  const promptBlock = context
    ? `<details style="margin-bottom:10px"><summary>查看/编辑 prompt(系统模板 + 数据上下文)</summary>` +
      `<div class="panel" style="margin-top:8px">` +
      `<div class="dim" style="font-size:12px;margin-bottom:4px">系统模板(可编辑,存本地库,对所有比赛生效)</div>` +
      `<textarea id="ai-system" style="width:100%;min-height:160px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12px;font-family:inherit">${esc(systemPrompt)}</textarea>` +
      `<div style="margin:6px 0 12px"><button onclick="aiSaveTemplate()" class="btn">保存模板</button> <button onclick="aiResetTemplate()" class="btn">恢复默认</button> <span id="ai-tpl-status" class="dim" style="font-size:12px"></span></div>` +
      `<div class="dim" style="font-size:12px;margin-bottom:4px">数据上下文(自动组装,只读;~${Math.round(context.prompt.length / 3)} tokens 量级)</div>` +
      `<pre id="ai-context" style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px">${esc(context.prompt)}</pre>` +
      `<button onclick="aiCopyPrompt()" class="btn">复制完整 prompt</button> <span class="dim" style="font-size:12px">没有 API key 时可粘贴到任意 AI 使用</span>` +
      `</div></details>`
    : `<p class="dim">无法组装上下文(比赛可能已开赛)。</p>`;

  const button = context
    ? keyReady
      ? `<button id="ai-go" onclick="aiAnalyze()" class="btn primary">生成分析</button> <span id="ai-status" class="dim" style="font-size:12px"></span>`
      : `<span class="dim">未配置 ANTHROPIC_API_KEY(写入 .env 后重启 board 即可一键生成);先用上方「复制完整 prompt」。</span>`
    : "";

  return (
    `<section id="ai"><h2>AI 分析 <small>结构化解读盘面信号;个人参考,不构成投注建议</small></h2>` +
    promptBlock +
    `<div style="margin-bottom:10px">${button}</div>` +
    `<div id="ai-history">${historyHtml}</div>` +
    `<script>
function aiBusy(b){ window.__busy = b; var btn=document.getElementById("ai-go"); if(btn) btn.disabled=b; }
async function aiAnalyze(){
  aiBusy(true);
  var s=document.getElementById("ai-status"); s.textContent="分析中…(通常 10-30 秒)";
  try {
    var res = await fetch("/api/analyze?fk=" + encodeURIComponent(${JSON.stringify(fixtureKey)}), {method:"POST"});
    var data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || res.status);
    s.textContent = "完成,刷新中…";
    sessionStorage.setItem("y", String(window.scrollY));
    location.reload();
  } catch(e) { s.textContent = "失败: " + e.message; aiBusy(false); }
}
async function aiSaveTemplate(){
  var t=document.getElementById("ai-system").value;
  var st=document.getElementById("ai-tpl-status");
  var res=await fetch("/api/template",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({template:t})});
  st.textContent = res.ok ? "已保存" : "保存失败";
}
async function aiResetTemplate(){
  var st=document.getElementById("ai-tpl-status");
  var res=await fetch("/api/template",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reset:true})});
  if(res.ok){ var d=await res.json(); document.getElementById("ai-system").value=d.template; st.textContent="已恢复默认"; }
}
function aiCopyPrompt(){
  var full=document.getElementById("ai-system").value + "\\n\\n---\\n\\n" + document.getElementById("ai-context").textContent;
  navigator.clipboard.writeText(full).then(function(){ document.getElementById("ai-tpl-status").textContent="已复制"; });
}
</script>` +
    `</section>`
  );
}

export function matchPage(fixtureKey: string): string {
  const row = getCurrentOdds(70).find((r) => r.fixtureKey === fixtureKey);
  if (!row) {
    return page(
      "比赛未找到",
      `<header class="top"><h1><a href="/">← WC26 Board</a></h1></header><p class="dim">没有找到这场比赛(可能已完赛,读层只覆盖未开赛与进行中场次)。</p>`
    );
  }

  const kickoff = new Date(row.kickoffUtc);
  const hoursTo = (kickoff.getTime() - Date.now()) / 3600_000;
  const countdown = row.live
    ? `进行中(开球于 ${Math.max(0, Math.round(-hoursTo * 60))} 分钟前)`
    : hoursTo >= 48
      ? `${Math.round(hoursTo / 24)} 天后`
      : `${Math.max(0, hoursTo).toFixed(1)} 小时后`;
  const liveBadge = row.live ? ` <span class="live-badge" style="font-size:13px">LIVE</span>` : "";

  const body =
    `<header class="top"><h1><a href="/">← WC26 Board</a></h1>${freshnessChips()}</header>` +
    `<h2 style="font-size:20px;margin-top:6px">${esc(matchZh(row))}${liveBadge} <small>${esc(row.match)}</small></h2>` +
    `<p class="dim">开球:${esc(bjFull.format(kickoff))}(北京) · ${esc(row.kickoffUtc)} · ${countdown}</p>` +
    aiSection(fixtureKey, row) +
    `<h2>各源三向归一概率 <small>diff 相对书商中位,红=偏高(避坑)、绿=偏低(划算)</small></h2>` +
    `<div class="panel">${sourceTable(row)}</div>` +
    hhadSection(fixtureKey, row) +
    `<h2>48h 概率走势 <small>15min 降采样,三向归一;体彩为离散点</small></h2>` +
    `<div class="panel">${historyCharts(fixtureKey)}</div>` +
    `<footer>纯本地只读聚合,个人参考,不构成投注建议。</footer>`;

  return page(`${matchZh(row)} · WC26`, body, 120);
}
