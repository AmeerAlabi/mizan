// Model access for the agents. Every call goes through Meterless Nightshift (the required primary
// provider) and is pinned to a Nemotron model so the run receipts show NVIDIA did the work.
import { env } from "../env.ts";
import { chat, loadConfig, type ChatMessage, type ChatResult, type MeterlessConfig, type ToolSpec } from "../llm/meterless.ts";
import type { AgentName, Trace } from "./trace.ts";

// Nightshift only serves models that sit in a lane; anything else falls through to meterless/auto.
// Deep work defaults to the fast lane's model until a bigger Nemotron is added to a lane and set
// in METERLESS_MODEL_DEEP.
export const MODELS = {
  fast: () => env("METERLESS_MODEL_FAST", "nvidia/nemotron-3.5-lightning-30b-a3b"),
  deep: () => env("METERLESS_MODEL_DEEP", MODELS.fast()),
};

let cfg: MeterlessConfig | null = null;
const config = () => (cfg ??= loadConfig());

export interface CallOptions {
  agent: AgentName;
  trace: Trace;
  tier: keyof typeof MODELS;
  tools?: ToolSpec[];
  purpose: string;
}

// NVIDIA's hosted trial endpoints sometimes return empty replies or hit their per-minute cap;
// Nightshift surfaces those as 502/503/504. Retry with backoff before failing the step.
const RETRYABLE = /HTTP 50[234]|empty_response|provider_deadline|fetch failed|rate|unreachable/i;

// NVIDIA's trial tier rejects bursts, so model calls are queued one at a time with a short gap.
// Agents still run in parallel; only their model requests take turns.
let queue: Promise<unknown> = Promise.resolve();
const GAP_MS = 400;

export function call(messages: ChatMessage[], o: CallOptions): Promise<ChatResult> {
  const next = queue.then(() => callNow(messages, o));
  queue = next.catch(() => undefined).then(() => new Promise((r) => setTimeout(r, GAP_MS)));
  return next;
}

async function callNow(messages: ChatMessage[], o: CallOptions): Promise<ChatResult> {
  const delays = [4000, 10000, 20000];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await chat(config(), messages, { tools: o.tools, model: MODELS[o.tier]() });
      if (!r.message || (!r.message.content && !r.message.tool_calls?.length)) throw new Error("empty_response from model");
      o.trace.emit(o.agent, "llm", o.purpose, { model: r.model, ms: r.ms, data: { tokens: r.usage, attempt: attempt + 1 } });
      return r;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt >= delays.length || !RETRYABLE.test(msg)) throw err;
      o.trace.emit(o.agent, "error", `Model call failed (${msg.slice(0, 80)}); retrying in ${delays[attempt] / 1000}s`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

// Extract the first JSON object from a reply (models sometimes wrap it in prose or code fences).
export function parseJson<T>(text: string | null | undefined): T {
  if (!text) throw new Error("empty reply");
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error(`no JSON object in reply: ${cleaned.slice(0, 120)}`);
  let depth = 0;
  let inString = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1)) as T;
  }
  throw new Error("unterminated JSON object in reply");
}

// Ask for a JSON object; on a malformed reply, show the model its error once and retry.
export async function callJson<T>(system: string, user: string, o: CallOptions, validate?: (v: T) => string | null): Promise<T> {
  const messages: ChatMessage[] = [
    { role: "system", content: `${system}\n\nRespond with a single JSON object and nothing else.` },
    { role: "user", content: user },
  ];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await call(messages, o);
    try {
      const value = parseJson<T>(r.message?.content);
      const problem = validate?.(value);
      if (!problem) return value;
      lastError = problem;
    } catch (err) {
      lastError = (err as Error).message;
    }
    messages.push({ role: "assistant", content: r.message?.content ?? "" }, { role: "user", content: `That reply was not usable (${lastError}). Reply again with only the corrected JSON object.` });
  }
  throw new Error(`${o.agent}: no valid JSON after retry (${lastError})`);
}
