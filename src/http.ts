import { log } from "./config.js";

// 大陆直连 PM/Odds API 链路偶发 HTTP=000(连接层失败),重试是常态而非异常
const TIMEOUT_MS = 30_000;
const RETRIES = 3;
const BACKOFF_MS = 2_000;

// 可选代理: 设了 HTTPS_PROXY 才启用
if (process.env.HTTPS_PROXY || process.env.https_proxy) {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export async function fetchJson<T = unknown>(url: string, label?: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
      }
    }
  }
  throw new Error(`fetchJson failed after ${RETRIES} attempts [${label ?? url}]: ${String(lastErr)}`);
}

// 同上,但额外暴露响应头(The Odds API 的配额计数在头里)
export async function fetchJsonWithHeaders<T = unknown>(
  url: string,
  label?: string,
  headers?: HeadersInit
): Promise<{ data: T; headers: Headers }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as T;
      return { data, headers: res.headers };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
      }
    }
  }
  throw new Error(`fetchJson failed after ${RETRIES} attempts [${label ?? url}]: ${String(lastErr)}`);
}

export { log };
