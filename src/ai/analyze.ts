// AI 调用层。Anthropic 走原生 /v1/messages;DeepSeek/Kimi/其它兼容口走 OpenAI Chat Completions。
// 结构化输出尽量用 response_format=json_object,并把最终可解析 JSON append-only 落 ai_analysis 表。
import "../http.js"; // 副作用: 设置 HTTPS_PROXY 全局代理 dispatcher(大陆直连 anthropic API 同样需要)
import {
  AI_MAX_TOKENS,
  AI_PROVIDER,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE,
  ANTHROPIC_MODEL,
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE,
  DEEPSEEK_MODEL,
  DEEPSEEK_REASONING_EFFORT,
  DEEPSEEK_TEMPERATURE,
  DEEPSEEK_THINKING,
  DEEPSEEK_THINKING_MODEL,
  KIMI_API_KEY,
  KIMI_BASE,
  KIMI_MODEL,
  KIMI_TEMPERATURE,
  KIMI_THINKING,
  OPENAI_COMPAT_API_KEY,
  OPENAI_COMPAT_BASE,
  OPENAI_COMPAT_MODEL,
  log,
} from "../config.js";
import { getMeta, insertAnalysis } from "../db.js";
import { buildMatchContext, type MatchContext } from "./context.js";

export const DEFAULT_SYSTEM_PROMPT = `你是一名足球博彩市场分析师,为个人研究解读一场 2026 世界杯比赛的多源赔率数据。输入已预计算:三向概率均为归一后口径,价差以百分点(pp)标注,走势为关键点采样。

分析原则:
- Pinnacle 与书商中位代表国际市场共识;Polymarket/Kalshi 是真金白银的预测市场,它们与书商的分歧本身是信号。
- 体彩 SP 含官方抽水,归一后与国际共识的差才有意义:体彩隐含概率偏高的方向回报相对差(避坑),偏低的方向赔率相对优。
- 盘口异动可能对应阵容/伤病等新信息,但你只能基于给定数据推断,不得臆造数据之外的事实。
- 平局概率被市场系统性低估/高估是常见盘面结构,注意三向之间的此消彼长。
- 结论要可操作但克制:lean 选你认为相对价值最高的方向;没有明显价值就选 no_bet。这是个人参考,不构成投注建议。
- AI 简报要比一句结论更深:给出价值地图、继续观察触发条件、数据质量影响和下一步应查看的信号;不要编造模型概率。

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
  brief_title?: string;
  market_read?: string;
  value_map?: { outcome: "home" | "draw" | "away" | "no_bet"; take: string; reason: string }[];
  watch_triggers?: string[];
  data_quality?: string;
  next_action?: string;
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
    brief_title: { type: "string", description: "一句话标题,突出本场最重要的读盘结论" },
    market_read: { type: "string", description: "更深入的盘面解读,说明主力源、走势、分歧与流动性如何组合" },
    value_map: {
      type: "array",
      description: "逐方向价值地图,不输出伪造概率",
      items: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["home", "draw", "away", "no_bet"] },
          take: { type: "string", description: "简短判断,如相对优/偏贵/中性/避开" },
          reason: { type: "string", description: "基于输入数据的理由" },
        },
        required: ["outcome", "take", "reason"],
        additionalProperties: false,
      },
    },
    watch_triggers: { type: "array", items: { type: "string" }, description: "赛前值得继续监控的价格、盘口或数据触发条件" },
    data_quality: { type: "string", description: "说明哪些数据新鲜/缺失/低频/样本化,以及它如何影响信心" },
    next_action: { type: "string", description: "下一步查看或等待什么信号;保持克制,不要给下注指令" },
  },
  required: [
    "lean",
    "confidence",
    "summary_zh",
    "key_signals",
    "risks",
    "sporttery_take",
    "brief_title",
    "market_read",
    "value_map",
    "watch_triggers",
    "data_quality",
    "next_action",
  ],
  additionalProperties: false,
} as const;

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

interface OpenAiChatResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | { type?: string; text?: string }[];
      reasoning_content?: string;
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

type OpenAiMessageContent = string | { type?: string; text?: string }[] | undefined;
type AiProviderId = "anthropic" | "deepseek" | "kimi" | "openai-compatible";
type ProviderKind = "anthropic" | "openai-compatible";
type ThinkingMode = "enabled" | "disabled";

interface AiProvider {
  id: AiProviderId;
  kind: ProviderKind;
  label: string;
  key: string;
  requiredKeyName: string;
  baseUrl: string;
  model: string;
  baseConfigName?: string;
  modelConfigName?: string;
  temperature?: string;
  thinking?: string;
  thinkingModel?: string;
  reasoningEffort?: string;
}

export interface AiProviderOverride {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  thinking?: string;
  temperature?: string;
}

export interface CurrentAiProvider {
  id: AiProviderId;
  label: string;
  model: string;
  baseUrl: string;
  requiredKeyName: string;
  keyReady: boolean;
  missingConfig: string | null;
}

interface ProviderResult {
  raw: string;
  usage: string;
  model: string;
}

const PROVIDER_ALIASES: Record<string, AiProviderId> = {
  anthropic: "anthropic",
  claude: "anthropic",
  deepseek: "deepseek",
  kimi: "kimi",
  moonshot: "kimi",
  openai: "openai-compatible",
  "openai-compatible": "openai-compatible",
  openai_compatible: "openai-compatible",
};

// 这些代际支持 adaptive thinking;其它(如 haiku)不送 thinking 字段
const ADAPTIVE_OK = /fable|opus-4-[678]|sonnet-4-6/;

function activeProviderId(rawProvider = AI_PROVIDER): AiProviderId {
  const id = PROVIDER_ALIASES[String(rawProvider || "").toLowerCase()];
  if (!id) throw new Error(`unsupported AI_PROVIDER=${rawProvider}; use anthropic, deepseek, kimi, or openai-compatible`);
  return id;
}

function withOverride(provider: AiProvider, override?: AiProviderOverride): AiProvider {
  if (!override) return provider;
  return {
    ...provider,
    key: typeof override.apiKey === "string" && override.apiKey.trim() ? override.apiKey.trim() : provider.key,
    baseUrl: typeof override.baseUrl === "string" && override.baseUrl.trim() ? override.baseUrl.trim() : provider.baseUrl,
    model: typeof override.model === "string" && override.model.trim() ? override.model.trim() : provider.model,
    thinking: typeof override.thinking === "string" && override.thinking.trim() ? override.thinking.trim() : provider.thinking,
    temperature: typeof override.temperature === "string" && override.temperature.trim() ? override.temperature.trim() : provider.temperature,
  };
}

function getProvider(override?: AiProviderOverride): AiProvider {
  const active = activeProviderId(override?.provider);
  let provider: AiProvider;
  switch (active) {
    case "anthropic":
      provider = {
        id: "anthropic",
        kind: "anthropic",
        label: "Anthropic",
        key: ANTHROPIC_API_KEY,
        requiredKeyName: "ANTHROPIC_API_KEY",
        baseUrl: ANTHROPIC_BASE,
        model: ANTHROPIC_MODEL,
        baseConfigName: "ANTHROPIC_BASE_URL",
        modelConfigName: "ANTHROPIC_MODEL",
      };
      break;
    case "deepseek":
      provider = {
        id: "deepseek",
        kind: "openai-compatible",
        label: "DeepSeek",
        key: DEEPSEEK_API_KEY,
        requiredKeyName: "DEEPSEEK_API_KEY",
        baseUrl: DEEPSEEK_BASE,
        model: DEEPSEEK_MODEL,
        baseConfigName: "DEEPSEEK_BASE_URL",
        modelConfigName: "DEEPSEEK_CHAT_MODEL",
        temperature: DEEPSEEK_TEMPERATURE,
        thinking: DEEPSEEK_THINKING,
        thinkingModel: DEEPSEEK_THINKING_MODEL,
        reasoningEffort: DEEPSEEK_REASONING_EFFORT,
      };
      break;
    case "kimi":
      provider = {
        id: "kimi",
        kind: "openai-compatible",
        label: "Kimi",
        key: KIMI_API_KEY,
        requiredKeyName: "KIMI_API_KEY 或 MOONSHOT_API_KEY",
        baseUrl: KIMI_BASE,
        model: KIMI_MODEL,
        baseConfigName: "KIMI_BASE_URL",
        modelConfigName: "KIMI_CHAT_MODEL",
        temperature: KIMI_TEMPERATURE,
        thinking: KIMI_THINKING,
      };
      break;
    case "openai-compatible":
      provider = {
        id: "openai-compatible",
        kind: "openai-compatible",
        label: "OpenAI-compatible",
        key: OPENAI_COMPAT_API_KEY,
        requiredKeyName: "OPENAI_COMPAT_API_KEY 或 OPENAI_API_KEY",
        baseUrl: OPENAI_COMPAT_BASE,
        model: OPENAI_COMPAT_MODEL,
        baseConfigName: "OPENAI_COMPAT_BASE_URL 或 OPENAI_BASE_URL",
        modelConfigName: "OPENAI_COMPAT_MODEL 或 OPENAI_MODEL",
      };
      break;
  }
  return withOverride(provider, override);
}

function missingProviderConfig(provider: AiProvider): string | null {
  if (!provider.key) return provider.requiredKeyName;
  if (!provider.baseUrl) return provider.baseConfigName ?? `${provider.id.toUpperCase()}_BASE_URL`;
  if (!provider.model) return provider.modelConfigName ?? `${provider.id.toUpperCase()}_MODEL`;
  return null;
}

export function currentAiProvider(override?: AiProviderOverride): CurrentAiProvider {
  const provider = getProvider(override);
  const missingConfig = missingProviderConfig(provider);
  return {
    id: provider.id,
    label: provider.label,
    model: provider.model || "(未配置)",
    baseUrl: provider.baseUrl,
    requiredKeyName: provider.requiredKeyName,
    keyReady: missingConfig === null,
    missingConfig,
  };
}

export function hasApiKey(override?: AiProviderOverride): boolean {
  try {
    return currentAiProvider(override).keyReady;
  } catch {
    return false;
  }
}

function parseThinking(value: string | undefined): ThinkingMode {
  const normalized = String(value ?? "").toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return "enabled";
  return "disabled";
}

function openAiModel(provider: AiProvider, thinking: ThinkingMode): string {
  if (provider.id === "deepseek" && thinking === "enabled") return provider.thinkingModel || provider.model;
  return provider.model;
}

function shouldSendThinking(provider: AiProvider, thinking: ThinkingMode): boolean {
  if (provider.id !== "deepseek" && provider.id !== "kimi") return false;
  if (thinking === "enabled") return true;
  // Kimi K2.7 Code is documented as always-thinking; omitting the field avoids an invalid disable request.
  return !(provider.id === "kimi" && provider.model.startsWith("kimi-k2.7-code"));
}

function jsonContract(system: string): string {
  return `${system}

输出必须是合法 JSON object,不要使用 Markdown 代码块,不要输出 JSON 之外的文字。字段 schema:
${JSON.stringify(ANALYSIS_SCHEMA, null, 2)}`;
}

function stripJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseVerdict(raw: string): AnalysisVerdict | null {
  try {
    return JSON.parse(stripJsonFence(raw)) as AnalysisVerdict;
  } catch {
    return null;
  }
}

function usageAnthropic(data: AnthropicResponse): string {
  return `in=${data.usage?.input_tokens ?? "?"} out=${data.usage?.output_tokens ?? "?"}`;
}

function usageOpenAi(data: OpenAiChatResponse): string {
  return `in=${data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? "?"} out=${data.usage?.completion_tokens ?? data.usage?.output_tokens ?? "?"}`;
}

function isRetryableError(e: unknown): boolean {
  return e instanceof RetryableError || (e instanceof Error && e.name === "TimeoutError") || e instanceof TypeError;
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e) || attempt === 3) throw e instanceof RetryableError ? new Error(e.message) : e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function callAnthropic(provider: AiProvider, system: string, userPrompt: string): Promise<ProviderResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: AI_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
  };
  if (ADAPTIVE_OK.test(provider.model)) body.thinking = { type: "adaptive" };

  return withRetries(async () => {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": provider.key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const data = (await res.json()) as AnthropicResponse;
    if (!res.ok) {
      const msg = `anthropic HTTP ${res.status}: ${data.error?.message ?? "unknown"}`;
      if (res.status !== 429 && res.status < 500) throw new Error(msg);
      throw new RetryableError(msg);
    }
    const text = data.content?.find((b) => b.type === "text")?.text;
    if (!text) throw new Error(`anthropic: empty response (stop_reason=${data.stop_reason ?? "?"})`);
    return { raw: text, usage: usageAnthropic(data), model: `${provider.id}:${provider.model}` };
  });
}

function messageContentText(content: OpenAiMessageContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

function responseFormatUnsupported(text: string): boolean {
  return /response_format|json_schema|json_object/i.test(text) && /unsupported|unknown|invalid|not support/i.test(text);
}

async function openAiPost(provider: AiProvider, body: Record<string, unknown>): Promise<{ res: Response; text: string }> {
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { res, text: await res.text() };
}

async function callOpenAiCompatible(provider: AiProvider, system: string, userPrompt: string): Promise<ProviderResult> {
  const thinking = parseThinking(provider.thinking);
  const model = openAiModel(provider, thinking);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: jsonContract(system) },
      { role: "user", content: userPrompt },
    ],
    max_tokens: AI_MAX_TOKENS,
    response_format: { type: "json_object" },
  };

  if (provider.temperature && !(provider.id === "deepseek" && thinking === "enabled")) {
    body.temperature = Number(provider.temperature);
  }
  if (shouldSendThinking(provider, thinking)) {
    body.thinking = { type: thinking };
    if (provider.id === "deepseek" && thinking === "enabled") body.reasoning_effort = provider.reasoningEffort || "high";
  }

  return withRetries(async () => {
    let { res, text } = await openAiPost(provider, body);
    if (!res.ok && responseFormatUnsupported(text)) {
      const fallback = { ...body };
      delete fallback.response_format;
      ({ res, text } = await openAiPost(provider, fallback));
    }

    if (!res.ok) {
      let msg = text.slice(0, 1500);
      try {
        const parsed = JSON.parse(text) as OpenAiChatResponse;
        msg = parsed.error?.message ?? JSON.stringify(parsed).slice(0, 1500);
      } catch {
        // keep raw text
      }
      const err = `${provider.label} HTTP ${res.status}: ${msg}`;
      if (res.status !== 429 && res.status < 500) throw new Error(err);
      throw new RetryableError(err);
    }

    const data = JSON.parse(text) as OpenAiChatResponse;
    const message = data.choices?.[0]?.message;
    const content = messageContentText(message?.content);
    const reasoningChars = typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0;
    if (!content.trim() && reasoningChars > 0) {
      throw new Error(
        `${provider.label} returned reasoning_content (${reasoningChars} chars) but no final content. Increase AI_MAX_TOKENS or turn provider thinking off.`
      );
    }
    if (!content.trim()) throw new Error(`${provider.label}: empty response`);
    return {
      raw: content,
      usage: usageOpenAi(data),
      model: `${provider.id}:${data.model || model}`,
    };
  });
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

export async function callProvider(system: string, userPrompt: string, override?: AiProviderOverride): Promise<ProviderResult> {
  const provider = getProvider(override);
  const missingConfig = missingProviderConfig(provider);
  if (missingConfig) throw new Error(`${missingConfig} is not set for AI_PROVIDER=${provider.id}`);
  if (provider.kind === "anthropic") return callAnthropic(provider, system, userPrompt);
  return callOpenAiCompatible(provider, system, userPrompt);
}

export async function analyzeMatch(fixtureKey: string, override?: AiProviderOverride): Promise<AnalysisOutcome> {
  const context = buildMatchContext(fixtureKey);
  if (!context) throw new Error(`fixture not found or already kicked off: ${fixtureKey}`);

  const system = currentSystemPrompt();
  const result = await callProvider(system, context.prompt, override);

  const verdict = parseVerdict(result.raw);
  const storedRaw = verdict ? JSON.stringify(verdict) : result.raw;
  if (!verdict) log(`ai: response is not valid JSON for ${fixtureKey} (refusal or truncation?)`);

  const id = insertAnalysis(fixtureKey, result.model, system, context.prompt, storedRaw);
  log(`ai: analyzed ${context.matchZh} model=${result.model} ${result.usage} -> #${id}`);
  return { id, fixtureKey, model: result.model, verdict, raw: storedRaw, context };
}
