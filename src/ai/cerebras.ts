/**
 * Cliente de la API de Cerebras de Brainloop (chat/completions).
 *
 * Una sola función (`cerebrasChat`) hace la petición, mide la telemetría y
 * normaliza los errores. Solo habla con api.cerebras.ai.
 */

export const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
export const CEREBRAS_MODELS_URL = 'https://api.cerebras.ai/v1/models';
/** Consola de Cerebras: allí se crea la cuenta gratuita y la API Key. */
export const CEREBRAS_CONSOLE_URL = 'https://cloud.cerebras.ai';
export const REQUEST_TIMEOUT_MS = 60000;

/** Modelos de Shared Inference disponibles (octubre de 2026). */
export const CEREBRAS_MODELS = ['gpt-oss-120b', 'qwen-3.8-27b'] as const;

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatTurn =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Herramienta en formato OpenAI/Cerebras (`tools` de chat/completions). */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; strict?: boolean; parameters: Record<string, unknown> };
}

export interface RateLimits {
  limitRequestsDay: string | null;
  remainingRequestsDay: string | null;
  resetRequestsDay: string | null;
  limitTokensMin: string | null;
  remainingTokensMin: string | null;
  resetTokensMin: string | null;
}

export interface CompletionResult {
  content: string;
  reasoning: string | null;
  finishReason: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timeMs: number;
  tokensPerSec: number;
  limits: RateLimits;
  /** Herramientas que el modelo pide ejecutar (vacío si responde directamente). */
  toolCalls: ToolCall[];
  /** Mensaje del asistente tal cual hay que devolverlo en el historial si pidió herramientas. */
  assistantTurn: ChatTurn;
}

export type CerebrasErrorKind = 'timeout' | 'auth' | 'rate' | 'model' | 'http' | 'network';

export class CerebrasError extends Error {
  kind: CerebrasErrorKind;
  status: number | null;
  /** Segundos que Cerebras pide esperar (cabecera retry-after), si los indica. */
  retryAfterSec: number | null;
  constructor(kind: CerebrasErrorKind, message: string, status: number | null = null, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'CerebrasError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatTurn[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
  parallelToolCalls?: boolean;
  fetchImpl?: typeof fetch;
}

const EMPTY_REPLY_LENGTH =
  'El modelo agotó el límite de tokens mientras razonaba. Prueba con una pregunta más concreta o un modo más rápido.';
const EMPTY_REPLY = 'El modelo no devolvió respuesta. Inténtalo de nuevo.';

export async function cerebrasChat(opts: ChatOptions): Promise<CompletionResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.6,
    // Los modelos actuales razonan antes de responder y esos tokens cuentan dentro del límite.
    max_completion_tokens: opts.maxTokens ?? 8192,
    stream: false,
  };
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
    if (opts.parallelToolCalls != null) body.parallel_tool_calls = opts.parallelToolCalls;
  }

  let response: Response;
  try {
    response = await doFetch(CEREBRAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new CerebrasError('timeout', `Cerebras no respondió en ${Math.round(timeoutMs / 1000)} s.`);
    }
    throw new CerebrasError('network', 'Sin conexión con api.cerebras.ai. Revisa tu internet.');
  }
  clearTimeout(timer);
  const elapsed = Date.now() - started;

  const h = (name: string) => response.headers?.get?.(name) ?? null;
  const limits: RateLimits = {
    limitRequestsDay: h('x-ratelimit-limit-requests-day'),
    remainingRequestsDay: h('x-ratelimit-remaining-requests-day'),
    resetRequestsDay: h('x-ratelimit-reset-requests-day'),
    limitTokensMin: h('x-ratelimit-limit-tokens-minute'),
    remainingTokensMin: h('x-ratelimit-remaining-tokens-minute'),
    resetTokensMin: h('x-ratelimit-reset-tokens-minute'),
  };

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const apiMsg: string | undefined = data?.error?.message ?? data?.message;
    const status = response.status;
    if (status === 401 || status === 403) throw new CerebrasError('auth', 'Cerebras rechazó la API Key. Revísala en la Bóveda.', status);
    if (status === 429) {
      const ra = Number(h('retry-after'));
      throw new CerebrasError(
        'rate',
        apiMsg || 'Has alcanzado el límite de uso de Cerebras. Espera un poco.',
        status,
        Number.isFinite(ra) && ra > 0 ? ra : null
      );
    }
    if (status === 404 || /model[^.]*(not found|does not exist|not available|unknown|no existe)/i.test(apiMsg ?? ''))
      throw new CerebrasError('model', apiMsg || 'Ese modelo no está disponible en tu cuenta de Cerebras.', status);
    throw new CerebrasError('http', apiMsg || `Error HTTP ${status} de Cerebras.`, status);
  }

  const choice = data?.choices?.[0];
  const finishReason: string | null = choice?.finish_reason ?? null;
  const rawReasoning = choice?.message?.reasoning;
  const reasoning = typeof rawReasoning === 'string' && rawReasoning.trim() ? rawReasoning.trim() : null;
  const toolCalls: ToolCall[] = Array.isArray(choice?.message?.tool_calls)
    ? choice.message.tool_calls
        .filter((c: any) => c && c.function && typeof c.function.name === 'string')
        .map((c: any, i: number) => ({
          id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`,
          type: 'function' as const,
          function: {
            name: c.function.name,
            arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
          },
        }))
    : [];
  const rawContent: string = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  let content = rawContent.trim();
  if (!content && !toolCalls.length) content = finishReason === 'length' ? EMPTY_REPLY_LENGTH : EMPTY_REPLY;
  const assistantTurn: ChatTurn = toolCalls.length
    ? { role: 'assistant', content: rawContent, tool_calls: toolCalls, ...(reasoning ? { reasoning } : {}) }
    : { role: 'assistant', content };

  const usage = data?.usage ?? {};
  const timeInfo = data?.time_info ?? {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  const completionSec = timeInfo.completion_time || elapsed / 1000;
  const tokensPerSec = completionSec > 0 ? Math.round(completionTokens / completionSec) : 0;
  const timeMs = Math.round(timeInfo.total_time ? timeInfo.total_time * 1000 : elapsed);

  return {
    content,
    reasoning,
    finishReason,
    model: typeof data?.model === 'string' ? data.model : opts.model,
    promptTokens,
    completionTokens,
    totalTokens,
    timeMs,
    tokensPerSec,
    limits,
    toolCalls,
    assistantTurn,
  };
}

/** Busca una API Key de Cerebras dentro de un texto (p. ej. lo copiado de la consola). */
export function extractCerebrasKey(text: string | null | undefined): string | null {
  const m = /\bcsk-[A-Za-z0-9_-]{20,200}\b/.exec(String(text ?? ''));
  return m ? m[0] : null;
}

export type KeyCheck =
  | { ok: true; models: string[] }
  | { ok: false; kind: 'format' | 'auth' | 'network' | 'timeout' | 'http'; message: string };

/**
 * Comprueba una API Key sin gastar tokens: GET /v1/models.
 * 200 → válida (devuelve los modelos disponibles); 401/403 → rechazada.
 */
export async function verifyCerebrasKey(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15000): Promise<KeyCheck> {
  const k = String(key || '').trim();
  if (!/^csk-[A-Za-z0-9_-]{20,200}$/.test(k)) {
    return { ok: false, kind: 'format', message: 'Eso no parece una API Key de Cerebras (empiezan por «csk-»).' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(CEREBRAS_MODELS_URL, { headers: { Authorization: `Bearer ${k}` }, signal: controller.signal });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, kind: 'auth', message: 'Cerebras rechazó esa clave. Cópiala de nuevo desde la consola.' };
    }
    if (!r.ok) return { ok: false, kind: 'http', message: `Cerebras respondió con un error ${r.status}. Inténtalo de nuevo.` };
    let data: any = null;
    try {
      data = await r.json();
    } catch {
      data = null;
    }
    const models: string[] = Array.isArray(data?.data) ? data.data.map((m: any) => String(m?.id ?? '')).filter(Boolean) : [];
    return { ok: true, models };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, kind: 'timeout', message: 'Cerebras tardó demasiado en responder.' };
    return { ok: false, kind: 'network', message: 'Sin conexión con api.cerebras.ai. Revisa tu internet.' };
  } finally {
    clearTimeout(timer);
  }
}

/** Título y texto listos para mostrar al usuario. */
export function describeError(err: unknown): { title: string; message: string } {
  if (err instanceof CerebrasError) {
    const titles: Record<CerebrasErrorKind, string> = {
      timeout: 'Tiempo de espera agotado',
      auth: 'API Key no válida',
      rate: 'Límite alcanzado',
      model: 'Modelo no disponible',
      http: 'Error de Cerebras',
      network: 'Sin conexión',
    };
    return { title: titles[err.kind], message: err.message };
  }
  return { title: 'Error inesperado', message: 'No se pudo completar la petición. Inténtalo de nuevo.' };
}

export function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
