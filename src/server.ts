// 本地只读决策 board。只绑 127.0.0.1,不对外(合规边界)。
// HTML 服务端渲染 + /api/* JSON(读层纯函数复用,与 CLI 同源)。
// 唯一的"写"入口是 AI 分析(结果落 ai_analysis 表)与 prompt 模板(meta 表)。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BOARD_PORT, log } from "./config.js";
import { boardPage, matchPage } from "./board/render.js";
import { getCurrentOdds } from "./queries/currentOdds.js";
import { getSportteryEdges } from "./queries/sportteryAvoidance.js";
import { getOutrightBoard } from "./queries/outright.js";
import { runHealthChecks } from "./queries/healthChecks.js";
import { getLineHistory } from "./queries/lineHistory.js";
import { analyzeMatch, currentSystemPrompt, DEFAULT_SYSTEM_PROMPT, hasApiKey } from "./ai/analyze.js";
import { listAnalyses, setMeta, db } from "./db.js";

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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  switch (url.pathname) {
    case "/":
      return html(res, boardPage());
    case "/match": {
      const fk = url.searchParams.get("fk");
      if (!fk) return notFound(res);
      return html(res, matchPage(fk));
    }
    case "/api/current":
      return json(res, getCurrentOdds(intParam(url, "limit", 12, 50)));
    case "/api/avoid":
      return json(res, getSportteryEdges(getCurrentOdds(50)));
    case "/api/outright":
      return json(res, getOutrightBoard(intParam(url, "limit", 10, 64)));
    case "/api/health":
      return json(res, runHealthChecks());
    case "/api/history": {
      const fk = url.searchParams.get("fk");
      if (!fk) return notFound(res);
      return json(
        res,
        getLineHistory(fk, {
          hours: intParam(url, "hours", 24, 24 * 14),
          bucketMinutes: intParam(url, "bucket", 30, 24 * 60),
        })
      );
    }
    case "/api/analyze": {
      if (req.method !== "POST") return notFound(res);
      const fk = url.searchParams.get("fk");
      if (!fk) return json(res, { error: "missing fk" }, 400);
      if (!hasApiKey()) return json(res, { error: "no_api_key", message: "ANTHROPIC_API_KEY 未配置,请用复制 prompt 的方式" }, 503);
      const outcome = await analyzeMatch(fk);
      return json(res, { id: outcome.id, model: outcome.model, verdict: outcome.verdict, raw: outcome.raw });
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

const server = createServer((req, res) => {
  void handle(req, res).catch((e) => {
    log(`board: 500 ${req.url}: ${String(e)}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
  });
});

server.listen(BOARD_PORT, "127.0.0.1", () => {
  log(`board: http://127.0.0.1:${BOARD_PORT}`);
});
