// 告警:daemon 每 tick 检测三类事件(盘口突变 / 体彩价差新条目 / health FAIL),
// alert_log 表 UNIQUE dedup_key 去重,新事件合并成一条 Server酱微信推送。
// 配额纪律:免费版每天约 5 条,绝不一事一推;再加日上限(meta 计数)兜底。
import { createHash } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { ALERT_JUMP_PP, ALERT_MAX_PER_DAY, SERVERCHAN_KEY, log } from "./config.js";
import { getMeta, insertAlertIfNew, setMeta } from "./db.js";
import { getCurrentOdds, LABELS, type Label } from "./queries/currentOdds.js";
import { getLineHistory } from "./queries/lineHistory.js";
import { getSportteryEdges } from "./queries/sportteryAvoidance.js";
import { runHealthChecks } from "./queries/healthChecks.js";
import { zhTeamName } from "./teams.js";

const LABEL_ZH: Record<Label, string> = { home: "主胜", draw: "平", away: "客胜" };
const MAIN_SOURCES = ["polymarket", "kalshi", "pinnacle"];

// sctapi.ftqq.com 是国内服务,必须绕开全局 HTTPS_PROXY(EnvHttpProxyAgent),
// 用独立直连 Agent 作为本请求的 dispatcher
const directAgent = new Agent();

const bjTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const bjDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

function zh(name: string): string {
  return zhTeamName(name) ?? name;
}

interface AlertEvent {
  kind: "jump" | "edge" | "health";
  dedupKey: string;
  title: string;
}

function collectEvents(): AlertEvent[] {
  const events: AlertEvent[] = [];
  const rows = getCurrentOdds(50);
  const horizon = Date.now() + 48 * 3600_000;
  const watched = rows.filter((r) => Date.parse(r.kickoffUtc) <= horizon);

  // 1. 主力源盘口突变(只看最近 3h,bucket 与 lineHistory 对齐保证 dedup key 稳定)
  for (const row of watched) {
    const matchZh = `${zh(row.homeTeam)} vs ${zh(row.awayTeam)}`;
    for (const history of getLineHistory(row.fixtureKey, { hours: 3, bucketMinutes: 30, jumpPp: ALERT_JUMP_PP, sources: MAIN_SOURCES })) {
      for (const jump of history.jumps) {
        events.push({
          kind: "jump",
          dedupKey: `jump|${history.source}|${row.fixtureKey}|${jump.label}|${jump.ts}`,
          title: `盘口突变 ${matchZh}${row.live ? "(进行中)" : ""}: ${LABEL_ZH[jump.label]} ${jump.deltaPp > 0 ? "+" : ""}${jump.deltaPp.toFixed(1)}pp(${history.source} ${bjTime.format(new Date(jump.ts))})`,
        });
      }
    }
  }

  // 2. 体彩 vs 共识新条目(体彩只在手动 fetch 后变化,天然低频)
  const edges = getSportteryEdges(rows);
  for (const [direction, list] of [
    ["avoid", edges.avoid],
    ["value", edges.value],
  ] as const) {
    for (const edge of list) {
      const outcomeZh = edge.outcome === "draw" ? "平" : zh(edge.outcome);
      events.push({
        kind: "edge",
        dedupKey: `edge|${edge.match}|${edge.outcome}|${direction}`,
        title: `体彩${direction === "avoid" ? "避坑" : "划算"} ${edge.match.split(/\s+vs\.?\s+/i).map(zh).join(" vs ")} ${outcomeZh}: 体彩 ${(edge.sporttery * 100).toFixed(1)}% vs 共识 ${(edge.bookAvg * 100).toFixed(1)}%(${edge.diffPp > 0 ? "+" : ""}${edge.diffPp.toFixed(1)}pp)`,
      });
    }
  }

  // 3. health FAIL(fail 集合变化才算新事件)
  const { checks, counts } = runHealthChecks();
  if (counts.fail > 0) {
    const fails = checks.filter((c) => c.level === "fail").map((c) => c.message);
    const hash = createHash("sha1").update(fails.join("\n")).digest("hex").slice(0, 12);
    events.push({
      kind: "health",
      dedupKey: `health|${hash}`,
      title: `health FAIL ×${counts.fail}: ${fails[0]}${counts.fail > 1 ? " …" : ""}`,
    });
  }

  return events;
}

async function pushServerChan(title: string, desp: string): Promise<void> {
  const url =
    `https://sctapi.ftqq.com/${encodeURIComponent(SERVERCHAN_KEY)}.send` +
    `?title=${encodeURIComponent(title)}&desp=${encodeURIComponent(desp)}`;
  const res = await undiciFetch(url, { dispatcher: directAgent, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`serverchan HTTP ${res.status}`);
  const data = (await res.json()) as { code?: number; message?: string };
  if (data.code !== 0) throw new Error(`serverchan code ${data.code}: ${data.message ?? ""}`);
}

function underDailyCap(): boolean {
  const key = `alerts_pushed_${bjDay.format(new Date())}`;
  return Number(getMeta(key) ?? 0) < ALERT_MAX_PER_DAY;
}

function bumpDailyCount(): void {
  const key = `alerts_pushed_${bjDay.format(new Date())}`;
  setMeta(key, String(Number(getMeta(key) ?? 0) + 1));
}

export async function checkAlerts(): Promise<number> {
  const fresh = collectEvents().filter((e) => insertAlertIfNew(e.kind, e.dedupKey, e.title));
  if (fresh.length === 0) return 0;

  log(`alerts: ${fresh.length} new event(s): ${fresh.map((e) => e.kind).join(",")}`);

  if (!SERVERCHAN_KEY) return fresh.length; // 无 key 只留痕,board 页可见
  if (!underDailyCap()) {
    log(`alerts: daily push cap (${ALERT_MAX_PER_DAY}) reached, logged only`);
    return fresh.length;
  }

  const title = fresh.length === 1 ? fresh[0].title.slice(0, 32) : `WC26 Board: ${fresh.length} 条新信号`;
  const desp = fresh.map((e) => `- ${e.title}`).join("\n\n");
  try {
    await pushServerChan(title, desp);
    bumpDailyCount();
    log(`alerts: pushed ${fresh.length} event(s) via serverchan`);
  } catch (e) {
    log(`alerts: serverchan push failed: ${String(e)}`); // 推送失败不影响留痕,下轮不重发(已落库)
  }
  return fresh.length;
}
