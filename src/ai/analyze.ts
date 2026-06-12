// Claude API 调用层。零依赖原则:undici fetch 直连 /v1/messages,不引 SDK。
// 结构化输出用 output_config.format(json_schema),保证返回可解析;
// 结果 append-only 落 ai_analysis 表,与 snapshot 同哲学(分析历史可回看)。
import "../http.js"; // 副作用: 设置 HTTPS_PROXY 全局代理 dispatcher(大陆直连 anthropic API 同样需要)
import { ANTHROPIC_API_KEY, ANTHROPIC_BASE, ANTHROPIC_MODEL, log } from "../config.js";
import { getMeta, insertAnalysis } from "../db.js";
import { buildMatchContext, type MatchContext } from "./context.js";

export const DEFAULT_SYSTEM_PROMPT = `你是一名足球博彩市场分析师,为个人研究解读一场 2026 世界杯比赛的多源赔率数据。输入已预计算:三向概率均为归一后口径,价差以百分点(pp)标注,走势为关键点采样。

分析原则:
- Pinnacle 与书商中位代表国际市场共识;Polymarket/Kalshi 是真金白银的预测市场,它们与书商的分歧本身是信号。
- 体彩 SP 含官方抽水,归一后与国际共识的差才有意义:体彩隐含概率偏高的方向回报相对差(避坑),偏低的方向赔率相对优。
- 盘口异动可能对应阵容/伤病等新信息,但你只能基于给定数据推断,不得臆造数据之外的事实。
- 平局概率被市场系统性低估/高估是常见盘面结构,注意三向之间的此消彼长。
- 结论要可操作但克制:lean 选你认为相对价值最高的方向;没有明显价值就选 no_bet。这是个人参考,不构成投注建议。

用中文输出。`;

export function currentSystemPrompt(): string {
  return getMeta("ai_prompt_template") ?? DEFAULT_SYSTEM_PROMPT;
}

export interface AnalysisVerdict {
  lean: "home" | "draw" | "away" | "no_bet";
  confidence: "low" | "medium" | "high";
  summary_zh: string;
  key_signals: string[];
  risks: string[];
  sporttery_take: string;
}

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    lean: { type: "string", enum: ["home", "draw", "away", "no_bet"], description: "相对价值最高的方向" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    summary_zh: { type: "string", description: "两三句话的总体判断" },
    key_signals: { type: "array", items: { type: "string" }, description: "支撑判断的关键盘面信号" },
    risks: { type: "array", items: { type: "string" }, description: "反向风险与不确定性" },
    sporttery_take: { type: "string", description: "对体彩玩家的具体提示: 哪些方向相对划算/该避开" },
  },
  required: ["lean", "confidence", "summary_zh", "key_signals", "risks", "sporttery_take"],
  additionalProperties: false,
} as const;

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

// 这些代际支持 adaptive thinking;其它(如 haiku)不送 thinking 字段
const ADAPTIVE_OK = /fable|opus-4-[678]|sonnet-4-6/;

async function callAnthropic(system: string, userPrompt: string): Promise<{ raw: string; usage: string }> {
  const body: Record<string, unknown> = {
    model: ANTHROPIC_MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
  };
  if (ADAPTIVE_OK.test(ANTHROPIC_MODEL)) body.thinking = { type: "adaptive" };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const data = (await res.json()) as AnthropicResponse;
      if (!res.ok) {
        const msg = `anthropic HTTP ${res.status}: ${data.error?.message ?? "unknown"}`;
        // 4xx(限流除外)是请求问题,重试无意义
        if (res.status !== 429 && res.status < 500) throw new Error(msg);
        throw new RetryableError(msg);
      }
      const text = data.content?.find((b) => b.type === "text")?.text;
      if (!text) throw new Error(`anthropic: empty response (stop_reason=${data.stop_reason ?? "?"})`);
      const usage = `in=${data.usage?.input_tokens ?? "?"} out=${data.usage?.output_tokens ?? "?"}`;
      return { raw: text, usage };
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof RetryableError || (e instanceof Error && e.name === "TimeoutError") || e instanceof TypeError;
      if (!retryable || attempt === 3) throw e instanceof RetryableError ? new Error(e.message) : e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

class RetryableError extends Error {}

export interface AnalysisOutcome {
  id: number;
  fixtureKey: string;
  model: string;
  verdict: AnalysisVerdict | null; // 解析失败(如 refusal)时为 null,raw 仍保留
  raw: string;
  context: MatchContext;
}

export function hasApiKey(): boolean {
  return ANTHROPIC_API_KEY.length > 0;
}

export async function analyzeMatch(fixtureKey: string): Promise<AnalysisOutcome> {
  const context = buildMatchContext(fixtureKey);
  if (!context) throw new Error(`fixture not found or already kicked off: ${fixtureKey}`);
  if (!hasApiKey()) throw new Error("ANTHROPIC_API_KEY is not set");

  const system = currentSystemPrompt();
  const { raw, usage } = await callAnthropic(system, context.prompt);

  let verdict: AnalysisVerdict | null = null;
  try {
    verdict = JSON.parse(raw) as AnalysisVerdict;
  } catch {
    log(`ai: response is not valid JSON for ${fixtureKey} (refusal or truncation?)`);
  }

  const id = insertAnalysis(fixtureKey, ANTHROPIC_MODEL, system, context.prompt, raw);
  log(`ai: analyzed ${context.matchZh} model=${ANTHROPIC_MODEL} ${usage} -> #${id}`);
  return { id, fixtureKey, model: ANTHROPIC_MODEL, verdict, raw, context };
}
