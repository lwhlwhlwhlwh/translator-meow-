import type { RateLimitGate, TranslationRequest } from './types';

type JsonRecord = Record<string, unknown>;
const MAX_TRANSLATION_CHARACTERS = 100_000;
const REQUEST_TIMEOUT_MS = 60_000;

export class TranslationResponseError extends Error {
  constructor(message: string) { super(message); this.name = 'TranslationResponseError'; }
}

export function completionUrl(baseUrl: string): string {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl.trim()); }
  catch { throw new Error('接口地址无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('接口地址仅支持 HTTP 或 HTTPS。');
  if (endpoint.username || endpoint.password) throw new Error('接口地址不能包含用户名或密码，请使用 API 密钥字段。');
  endpoint.hash = '';
  const path = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return endpoint.toString();
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap(part => {
    if (typeof part === 'string') return [part];
    const item = record(part);
    return typeof item?.text === 'string' ? [item.text] : [];
  });
  return parts.length ? parts.join('') : undefined;
}

export function extractTranslationText(data: unknown): string {
  const root = record(data);
  if (!root) throw new TranslationResponseError('接口响应不是 JSON 对象。');
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = record(choices[0]);
  const message = record(firstChoice?.message);
  const candidates: unknown[] = [message?.content, firstChoice?.text, root.output_text];
  const output = Array.isArray(root.output) ? root.output : [];
  for (const item of output) candidates.push(record(item)?.content);
  for (const candidate of candidates) {
    const result = contentText(candidate)?.trim();
    if (result) return result;
  }
  const shape = Object.keys(root).slice(0, 8).join('、') || '空对象';
  throw new TranslationResponseError(`接口响应中未找到翻译文本（顶层字段：${shape}）。请确认服务兼容 OpenAI 文本响应格式。`);
}

export function normalizeTranslation(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').replace(/[\p{P}\p{S}]/gu, '').toLocaleLowerCase();
}

function isSameLanguage(sourceLang: string, targetLang: string): boolean {
  const normalizeLanguage = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]/g, '');
  const source = normalizeLanguage(sourceLang);
  const target = normalizeLanguage(targetLang);
  return Boolean(source && target && !/(自动|auto|detect)/i.test(source) && source === target);
}

export function isNontrivialTranslationUnit(source: string): boolean {
  const trimmed = source.trim();
  const normalized = normalizeTranslation(trimmed);
  if (normalized.length < 8) return false;
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(trimmed) || /^[-+]?\d[\d\s.,:%+\-/]*$/.test(trimmed)) return false;
  const words = trimmed.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 1 && /^[\p{Script=Latin}\p{M}'’-]+$/u.test(words[0])) return false;
  if (words.length <= 4 && words.every(word => /^\p{Lu}[\p{L}'’-]*$/u.test(word))) return false;
  return true;
}

export function isMeaningfulUnchanged(source: string, translated: string, sourceLang = '', targetLang = ''): boolean {
  if (isSameLanguage(sourceLang, targetLang) || !isNontrivialTranslationUnit(source)) return false;
  return normalizeTranslation(source) === normalizeTranslation(translated);
}

export function unchangedWarning(source: string, translated: string, sourceLang = '', targetLang = ''): string | undefined {
  return isMeaningfulUnchanged(source, translated, sourceLang, targetLang)
    ? '译文与原文基本相同。请检查服务商、模型及源/目标语言设置；可更换一段明显不同语言的文本测试。'
    : undefined;
}

function apiErrorMessage(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = record(JSON.parse(body));
    const error = record(parsed?.error);
    const candidate = error?.message ?? parsed?.message ?? parsed?.detail ?? parsed?.error;
    if (typeof candidate === 'string') detail = candidate.trim();
  } catch { /* retain plain response text */ }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  const hint = status === 400 ? '请检查模型名、接口地址和请求参数。'
    : status === 401 ? '请检查 API 密钥是否正确或已过期。'
      : status === 403 ? '当前密钥或账号无权访问该模型。' : '';
  return `接口返回 ${status}${detail ? `：${detail}` : ''}${hint ? ` ${hint}` : ''}`;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createRateLimitGate(): RateLimitGate {
  let blockedUntil = 0;
  let probing = false;
  let ticket = 0;
  return {
    pause(delayMs) { blockedUntil = Math.max(blockedUntil, Date.now() + delayMs); probing = false; },
    resume(currentTicket) { if (currentTicket === ticket) { blockedUntil = 0; probing = false; } },
    async wait(signal) {
      while (blockedUntil > 0) {
        const remaining = blockedUntil - Date.now();
        if (remaining > 0) { await abortableDelay(remaining, signal); continue; }
        if (!probing) { probing = true; return ++ticket; }
        await abortableDelay(10, signal);
      }
      return 0;
    }
  };
}

function retryAfterMs(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  const exponential = Math.min(1000 * 2 ** attempt, 15_000);
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

class RateLimitError extends Error {
  constructor(public readonly delayMs: number, message: string) { super(message); this.name = 'RateLimitError'; }
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timeoutError = new Error(`接口请求超过 ${REQUEST_TIMEOUT_MS / 1000} 秒未响应。`);
  timeoutError.name = 'TranslationTimeoutError';
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(timeoutError), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function translate({ settings, text, signal, rateLimitGate, onStatus }: TranslationRequest): Promise<string> {
  if (!settings.baseUrl || !settings.model || !settings.targetLang) throw new Error('请先填写接口地址、模型和目标语言。');
  if (!text.trim()) throw new Error('没有可翻译的文本。');
  if (text.length > MAX_TRANSLATION_CHARACTERS) throw new Error(`单次翻译文本不能超过 ${MAX_TRANSLATION_CHARACTERS.toLocaleString('en-US')} 个字符。`);
  const url = completionUrl(settings.baseUrl);
  let last = '';
  const maxServerAttempts = 3;
  const maxRateLimitAttempts = 5;
  let serverAttempts = 0;
  let rateLimitAttempts = 0;
  while (true) {
    try {
      const gateTicket = await rateLimitGate?.wait(signal) ?? 0;
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
        body: JSON.stringify({
          model: settings.model, temperature: 0.1,
          messages: [
            { role: 'system', content: `You are a precise translator. Translate from ${settings.sourceLang || 'the detected source language'} to ${settings.targetLang}. Preserve formatting, placeholders, numbers, names, and line breaks. Return only the translation.` },
            { role: 'user', content: text }
          ]
        })
      }, signal);
      if (!response.ok) {
        const body = await response.text();
        if (response.status === 429) {
          if (rateLimitAttempts >= maxRateLimitAttempts - 1) {
            throw new TranslationResponseError(`${apiErrorMessage(429, body)} 已重试 ${maxRateLimitAttempts} 次仍被限流，请降低文档并发数、稍后重试，或检查服务商额度。`);
          }
          const delayMs = retryAfterMs(response.headers.get('retry-after'), rateLimitAttempts++);
          rateLimitGate?.pause(delayMs);
          onStatus?.(`接口限流，${Math.max(1, Math.ceil(delayMs / 1000))} 秒后重试`);
          throw new RateLimitError(delayMs, apiErrorMessage(429, body));
        }
        const error = new Error(apiErrorMessage(response.status, body));
        error.name = response.status >= 400 && response.status < 500 ? 'TranslationRequestError' : 'TranslationServerError';
        throw error;
      }
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new TranslationResponseError('接口返回的内容不是有效 JSON。请确认接口地址指向 OpenAI 兼容的聊天补全端点。'); }
      rateLimitGate?.resume(gateTicket);
      return extractTranslationText(data);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      if (error instanceof RateLimitError) {
        await (rateLimitGate ? rateLimitGate.wait(signal) : abortableDelay(error.delayMs, signal));
        continue;
      }
      last = (error as Error).message;
      if ((error as Error).name === 'TranslationRequestError' || error instanceof TranslationResponseError) throw new Error(`翻译失败：${last}`);
      serverAttempts++;
      if (serverAttempts >= maxServerAttempts) break;
      await abortableDelay(500 * 2 ** (serverAttempts - 1), signal);
    }
  }
  throw new Error(`翻译失败：${last}`);
}
