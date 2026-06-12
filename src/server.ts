// 本地只读决策 board。只绑 127.0.0.1,不对外(合规边界)。
// HTML 服务端渲染 + /api/* JSON(读层纯函数复用,与 CLI 同源)。
import { createServer, type ServerResponse } from "node:http";
import { BOARD_PORT, log } from "./config.js";
import { boardPage, matchPage } from "./board/render.js";
import { getCurrentOdds } from "./queries/currentOdds.js";
import { getSportteryEdges } from "./queries/sportteryAvoidance.js";
import { getOutrightBoard } from "./queries/outright.js";
import { runHealthChecks } from "./queries/healthChecks.js";
import { getLineHistory } from "./queries/lineHistory.js";

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
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
      default:
        return notFound(res);
    }
  } catch (e) {
    log(`board: 500 ${url.pathname}: ${String(e)}`);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`internal error: ${String(e)}`);
  }
});

server.listen(BOARD_PORT, "127.0.0.1", () => {
  log(`board: http://127.0.0.1:${BOARD_PORT}`);
});
