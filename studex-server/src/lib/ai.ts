/**
 * Google's Gemini API, through the official `@google/genai` SDK.
 *
 * What is here is the request, the fallback to a second model, and the failure
 * modes worth naming. The SDK's own retries are left off: a busy model is
 * handed to the next one in the chain instead, and each attempt is logged
 * against the model that made it.
 *
 * Nothing in this file knows what Studex is. It takes a role, a system prompt
 * and a user message and gives back text — plus which model actually wrote it,
 * because with three models in play "which one answered" is the first question
 * anyone debugging an odd answer asks.
 */
import { ApiError as GeminiApiError, GoogleGenAI, type Content } from '@google/genai';
import { config, type AiRole } from './config.js';
import { currentKey } from './ai-key.js';

export type { AiRole } from './config.js';

const TIMEOUT_MS = 90_000;
/** The Reader reads whole units of a specification and thinks first. */
const READER_TIMEOUT_MS = 180_000;

export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** True when trying the identical request again could plausibly work. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The model that answered — the backup, if the first choice was busy. */
  model: string;
  /** In US dollars. Gemini does not report it, so this stays zero. */
  cost: number;
}

/** One attempt, successful or not, so the caller can log every model it tried. */
export interface Attempt {
  model: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
}

/** Pro models think by default, and cannot have it switched off entirely. */
function isReasoner(model: string): boolean {
  return /pro/i.test(model);
}

export interface CompleteInput {
  role: AiRole;
  system: string;
  prompt: string;
  maxTokens: number;
  /** 0 for the structured callers; the default is left to the model. */
  temperature?: number;
  /** Ask for a JSON response. Parsing is still the caller's. */
  json?: boolean;
  /**
   * Earlier turns of a conversation, oldest first, sent before `prompt`. Only
   * the chat uses it; every other caller is one question and one answer.
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Called once per model tried, in order. */
  onAttempt?: (attempt: Attempt) => void;
}

/**
 * One client per key. Created lazily, because the key can be pasted into
 * Settings after the server started, and replaced when it changes.
 */
let client: { key: string; ai: GoogleGenAI } | null = null;

function clientFor(key: string): GoogleGenAI {
  if (client?.key !== key) {
    client = {
      key,
      ai: new GoogleGenAI({
        apiKey: key,
        httpOptions: { baseUrl: config.ai.baseUrl },
      }),
    };
  }
  return client.ai;
}

/**
 * Asks for one completion from the model behind a role, and from its backup if
 * the first is rate-limited, down or unreachable.
 *
 * `maxTokens` is a real limit and not a formality: every caller here produces
 * something with a natural size. A response cut off by that limit is reported
 * rather than returned half — a truncated JSON array parses as nothing useful
 * anyway, and a truncated explanation that stops mid-sentence is worse than an
 * error.
 */
export async function complete(input: CompleteInput): Promise<Completion> {
  const key = currentKey();
  if (!key) throw new AiError('This install of Studex has no AI configured.', null, false);

  const chain = modelChain(input.role);

  let last: AiError | null = null;
  for (const model of chain) {
    const started = Date.now();
    try {
      const result = await once(model, key, input);
      input.onAttempt?.({
        model, ok: true, status: 200, error: null,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      const failure = err instanceof AiError ? err : new AiError((err as Error).message, null, true);
      input.onAttempt?.({
        model, ok: false, status: failure.status, error: failure.message.slice(0, 300),
        inputTokens: 0, outputTokens: 0, cost: 0, durationMs: Date.now() - started,
      });
      last = failure;
      // Only a busy or broken model is worth handing to the backup. A request
      // the model rejected on its merits would be rejected by the next one too.
      if (!failure.retryable) throw failure;
    }
  }
  throw last ?? new AiError('The model did not answer.', null, true);
}

/**
 * The role's own two models first, then every other configured model as a last
 * resort. Quotas are per model on Gemini's free tier, so when one is exhausted
 * a different one very often still answers.
 */
export function modelChain(role: CompleteInput['role']): string[] {
  const route = config.ai.models[role];
  const others = Object.values(config.ai.models).flatMap((r) => [r.primary, r.backup]);
  return [...new Set([route.primary, route.backup, ...others].filter((m): m is string => Boolean(m)))];
}

function errorFor(status: number, detail: string): AiError {
  const message = status === 429
    ? 'The model is busy right now (the free tier is rate-limited). Try again in a minute.'
    : status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))
      ? 'Google AI Studio did not accept the API key. Check GEMINI_API_KEY, or the key in Settings → AI.'
      : `The model refused the request (${status}): ${detail.slice(0, 300)}`;
  const keyProblem = /api key/i.test(detail);
  // Google's bare "invalid argument" usually means this model does not accept
  // a setting another model does (thinking, above all), so the next is worth a try.
  const modelQuirk = status === 400 && /request contains an invalid argument/i.test(detail);
  return new AiError(message, status, !keyProblem && (status === 429 || status >= 500 || status === 404 || modelQuirk));
}

async function once(model: string, key: string, input: CompleteInput): Promise<Completion> {
  const contents: Content[] = [
    ...(input.history ?? []).map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    })),
    { role: 'user', parts: [{ text: input.prompt }] },
  ];

  let response;
  try {
    response = await clientFor(key).models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: input.system,
        // Thinking counts against the output budget, so every model gets room
        // to think on top of the answer's own.
        maxOutputTokens: input.maxTokens + (isReasoner(model) ? 4_000 : 1_024),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.json ? { responseMimeType: 'application/json' } : {}),
        // Thinking is kept short: every caller here has a natural size, and the
        // thoughts are never shown. Never a budget of 0 — the newer Flash-Lite
        // models reject it as an invalid argument.
        thinkingConfig: { thinkingBudget: isReasoner(model) ? 2_048 : 512 },
        httpOptions: { timeout: input.role === 'reader' || isReasoner(model) ? READER_TIMEOUT_MS : TIMEOUT_MS },
      },
    });
  } catch (err) {
    if (err instanceof GeminiApiError) throw errorFor(err.status, err.message);
    // A timeout or a dead network. Worth trying again; not worth a stack trace
    // in front of someone who highlighted a paragraph.
    throw new AiError(`Could not reach the model: ${(err as Error).message}`, null, true);
  }

  const candidate = response.candidates?.[0];
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) throw new AiError(`The model declined to answer (${blocked}).`, 400, false);
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new AiError('The answer was longer than the space allowed for it. Try a smaller selection.', null, false);
  }
  if (candidate?.finishReason === 'SAFETY') {
    throw new AiError('The model declined to answer that.', 400, false);
  }

  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
  if (!text) throw new AiError('The model returned an empty answer.', null, true);

  return {
    text,
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
    model: response.modelVersion || model,
    cost: 0,
  };
}

function unfence(text: string): string {
  // Reasoning models occasionally leak a <think> block even when told not to.
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
}

/**
 * Pulls the first JSON array out of an answer.
 *
 * Models are told to reply with an array and nothing else, and mostly do. What
 * they also do, occasionally, is wrap it in a ```json fence or write "Here are
 * the cards:" first. Rejecting those would be correct and useless, so the
 * fence is stripped and the outermost brackets are found. Anything beyond that
 * is a real failure and is reported as one.
 *
 * A model in JSON mode cannot answer with a bare array, so an object holding
 * exactly one array is accepted as that array.
 */
export function extractJsonArray(text: string): unknown[] {
  const unfenced = unfence(text);
  const objectFirst = unfenced.indexOf('{') !== -1
    && (unfenced.indexOf('[') === -1 || unfenced.indexOf('{') < unfenced.indexOf('['));
  if (objectFirst) {
    try {
      const wrapped = extractJsonObject(unfenced);
      const arrays = Object.values(wrapped).filter(Array.isArray);
      if (arrays.length === 1) return arrays[0] as unknown[];
    } catch { /* fall through to the bracket search */ }
  }

  const start = unfenced.indexOf('[');
  const end = unfenced.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new AiError('The model did not answer with a list.', null, true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new AiError('The model’s answer was not valid JSON.', null, true);
  }
  if (!Array.isArray(parsed)) throw new AiError('The model did not answer with a list.', null, true);
  return parsed;
}

/** The same, for an answer that should be one JSON object. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const unfenced = unfence(text);
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new AiError('The model did not answer with an object.', null, true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new AiError('The model’s answer was not valid JSON.', null, true);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiError('The model did not answer with an object.', null, true);
  }
  return parsed as Record<string, unknown>;
}
