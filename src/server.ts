// 本地只读决策 board。只绑 127.0.0.1,不对外(合规边界)。
// HTML 服务端渲染 + /api/* JSON(读层纯函数复用,与 CLI 同源)。
// 唯一的"写"入口是 AI 分析(结果落 ai_analysis 表)与 prompt 模板(meta 表)。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BOARD_PORT, BOARD_PORT_EXPLICIT, log } from "./config.js";
import { boardPage, matchPage, opportunitiesPage, readWalrusManifest, reviewPage, walrusPage } from "./board/render.js";
import { parseLocale } from "./board/i18n.js";
import { getCurrentOdds } from "./queries/currentOdds.js";
import { getSportteryEdges } from "./queries/sportteryAvoidance.js";
import { getOutrightBoard } from "./queries/outright.js";
import { runHealthChecks } from "./queries/healthChecks.js";
import { getLineHistory } from "./queries/lineHistory.js";
import { getMarketRadar } from "./queries/marketIntelligence.js";
import { getProbabilityCandidates } from "./queries/probabilityModel.js";
import { getMatchEventBundle } from "./queries/matchEvents.js";
import { aiProviderOptions, analyzeMatch, currentAiProvider, currentSystemPrompt, DEFAULT_SYSTEM_PROMPT, hasApiKey, type AiProviderOverride } from "./ai/analyze.js";
import { analyzeBoardBettingPlan, boardPlanSystemPrompt, buildBoardBettingContext, latestBoardVerdict, planConstants, type BoardPromptLocale } from "./ai/boardPlan.js";
import { listAnalyses, listWalrusPublishLog, setMeta, db, getMeta } from "./db.js";
import { getOfferedOddsForFixtures } from "./queries/offeredOdds.js";

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const n = Number(url.searchParams.get(name));
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerOverride(body: Record<string, unknown>): AiProviderOverride {
  return {
    provider: str(body, "provider"),
    apiKey: str(body, "apiKey"),
    baseUrl: str(body, "baseUrl"),
    model: str(body, "model"),
    thinking: str(body, "thinking"),
    temperature: str(body, "temperature"),
    maxTokens: str(body, "maxTokens"),
  };
}

function moneyParam(body: Record<string, unknown>, name: string): number {
  const raw = body[name];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function boardPromptLocale(url: URL): BoardPromptLocale {
  return url.searchParams.get("lang") === "zh" ? "zh" : "en";
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const locale = parseLocale(url.searchParams.get("lang"));

  switch (url.pathname) {
    case "/":
      return html(res, boardPage(locale));
    case "/opportunities":
      return html(res, opportunitiesPage(locale));
    case "/review":
      return html(res, reviewPage(locale));
    case "/walrus":
      return html(res, walrusPage(locale));
    case "/match": {
      const fk = url.searchParams.get("fk");
      if (!fk) return notFound(res);
      return html(res, matchPage(fk, locale));
    }
    case "/api/radar":
      return json(res, getMarketRadar(intParam(url, "limit", 50, 70)));
    case "/api/probability":
      return json(res, getProbabilityCandidates(intParam(url, "limit", 70, 70), url.searchParams.get("fk")));
    case "/api/current":
      return json(res, getCurrentOdds(intParam(url, "limit", 12, 50)));
    case "/api/avoid":
      return json(res, getSportteryEdges(getCurrentOdds(50)));
    case "/api/outright":
      return json(res, getOutrightBoard(intParam(url, "limit", 10, 64)));
    case "/api/health":
      return json(res, runHealthChecks());
    case "/api/walrus":
      return json(res, {
        latest: {
          manifestBlobId: getMeta("walrus_latest_manifest_blob_id"),
          manifestObjectId: getMeta("walrus_latest_manifest_object_id"),
          publishedAt: getMeta("walrus_latest_published_at"),
          network: getMeta("walrus_latest_network"),
          schemaVersion: getMeta("walrus_latest_schema_version"),
          error: getMeta("walrus_latest_error"),
          artifactCount: getMeta("walrus_latest_artifact_count"),
          totalBytes: getMeta("walrus_latest_total_bytes"),
        },
        manifest: readWalrusManifest(),
        logs: listWalrusPublishLog(20),
      });
    case "/api/ai/providers":
      return json(res, {
        current: currentAiProvider(),
        providers: aiProviderOptions(),
      });
    case "/api/history": {
      const fk = url.searchParams.get("fk");
      if (!fk) return notFound(res);
      return json(
        res,
        getLineHistory(fk, {
          hours: intParam(url, "hours", 24, 24 * 14),
          bucketMinutes: intParam(url, "bucket", 30, 24 * 60),
          fromTs: url.searchParams.get("from") ?? undefined,
          toTs: url.searchParams.get("to") ?? undefined,
        })
      );
    }
    case "/api/match-events": {
      const fk = url.searchParams.get("fk");
      if (!fk) return json(res, { error: "missing fk" }, 400);
      return json(res, getMatchEventBundle(fk));
    }
    case "/api/analyze": {
      if (req.method !== "POST") return notFound(res);
      const fk = url.searchParams.get("fk");
      if (!fk) return json(res, { error: "missing fk" }, 400);
      const body = await readJsonBody(req);
      const override = providerOverride(body);
      if (!hasApiKey(override)) {
        const provider = currentAiProvider(override);
        const missing = provider.missingConfig ?? provider.requiredKeyName;
        const message =
          locale === "zh"
            ? `${missing} 未配置,请用复制 prompt 的方式`
            : `${missing} is not configured. Copy the prompt instead.`;
        return json(res, { error: "no_api_key", message }, 503);
      }
      const outcome = await analyzeMatch(fk, override);
      return json(res, { id: outcome.id, model: outcome.model, verdict: outcome.verdict, raw: outcome.raw });
    }
    case "/api/analyze-board": {
      if (req.method !== "POST") return notFound(res);
      const body = await readJsonBody(req);
      const override = providerOverride(body);
      if (!hasApiKey(override)) {
        const provider = currentAiProvider(override);
        const missing = provider.missingConfig ?? provider.requiredKeyName;
        const message =
          locale === "zh"
            ? `${missing} 未配置,请用复制 prompt 的方式`
            : `${missing} is not configured. Copy the prompt instead.`;
        return json(res, { error: "no_api_key", message }, 503);
      }
      const bankroll = moneyParam(body, "bankroll");
      const maxDailyLoss = moneyParam(body, "maxDailyLoss");
      if (!bankroll || !maxDailyLoss) return json(res, { error: "missing_bankroll", message: "bankroll and maxDailyLoss are required" }, 400);
      const outcome = await analyzeBoardBettingPlan({
        fixtureKey: str(body, "fixtureKey") ?? url.searchParams.get("fk"),
        bankroll,
        maxDailyLoss,
        override,
        locale: boardPromptLocale(url),
      });
      return json(res, { id: outcome.id, model: outcome.model, verdict: outcome.verdict, plan: outcome.plan, constants: planConstants() });
    }
    case "/api/board-prompt": {
      const fk = url.searchParams.get("fk");
      const promptLocale = boardPromptLocale(url);
      return json(res, { system: boardPlanSystemPrompt(promptLocale), context: buildBoardBettingContext(fk, promptLocale) });
    }
    case "/api/board-plan/latest": {
      const latest = latestBoardVerdict();
      if (!latest?.verdict) return json(res, { latest: null, constants: planConstants() });
      const fixtureKeys = [...new Set(latest.verdict.recommendations.map((pick) => pick.fixture_key))];
      return json(res, { latest, offeredOdds: getOfferedOddsForFixtures(fixtureKeys), constants: planConstants() });
    }
    case "/api/analyses": {
      const fk = url.searchParams.get("fk");
      if (!fk) return notFound(res);
      return json(res, listAnalyses(fk, intParam(url, "limit", 5, 20)));
    }
    case "/api/template": {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (body.reset) {
          db.prepare(`DELETE FROM meta WHERE key='ai_prompt_template'`).run();
        } else if (typeof body.template === "string" && body.template.trim()) {
          setMeta("ai_prompt_template", body.template);
        } else {
          return json(res, { error: "empty template" }, 400);
        }
      }
      const template = currentSystemPrompt();
      return json(res, { template, isDefault: template === DEFAULT_SYSTEM_PROMPT });
    }
    default:
      return notFound(res);
  }
}

function createBoardServer() {
  return createServer((req, res) => {
    void handle(req, res).catch((e) => {
      log(`board: 500 ${req.url}: ${String(e)}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    });
  });
}

function listen(port: number): void {
  const server = createBoardServer();
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !BOARD_PORT_EXPLICIT && port < 4636) {
      const nextPort = port + 1;
      log(`board: 127.0.0.1:${port} is in use, trying ${nextPort}`);
      server.close();
      listen(nextPort);
      return;
    }
    const hint = BOARD_PORT_EXPLICIT ? "set BOARD_PORT to a free local port" : "free the port or set BOARD_PORT";
    log(`board: failed to listen on 127.0.0.1:${port}: ${error.code ?? error.message}; ${hint}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    log(`board: http://127.0.0.1:${port}`);
  });
}

listen(BOARD_PORT);
