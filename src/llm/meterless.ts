// Meterless Runtime (Nightshift) as the primary AI provider, per the Meterless Power Prompt contract:
// OpenAI-compatible, bearer token, `meterless-app` header on every call, `meterless-scope: user` on chat,
// model discovery via GET /v1/models, 180 s timeout, and 401/403 reported as "unauthorized", not "offline".
import { env } from "../env.ts";

export const APP_ID = "mizan";
export const TIMEOUT_MS = 180_000;
const AUTO_DETECT_PORTS = [8088, 8090, 8787, 11434];

export type ProviderStatus = "online" | "unauthorized" | "offline";

export interface MeterlessConfig {
  baseUrl: string; // always ends in /v1
  token: string;
  model: string;
}

// Accept pasted URLs with or without /v1 (or a trailing slash) and never double the path.
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// Quick Connect links look like http://host:port/connect#k=<key>; the key never leaves the fragment.
export function parseConnectLink(link: string): { baseUrl: string; token: string } | null {
  try {
    const u = new URL(link);
    const key = new URLSearchParams(u.hash.replace(/^#/, "")).get("k");
    if (!key) return null;
    return { baseUrl: normalizeBaseUrl(`${u.protocol}//${u.host}`), token: key };
  } catch {
    return null;
  }
}

export function loadConfig(): MeterlessConfig {
  const token = env("METERLESS_RUNTIME_TOKEN");
  if (token === "rt-local") throw new Error("METERLESS_RUNTIME_TOKEN is the placeholder rt-local; copy the real key from the Nightshift Console.");
  return {
    baseUrl: normalizeBaseUrl(env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1")),
    token,
    model: env("METERLESS_MODEL", "meterless/auto"),
  };
}

function headers(token: string, chat = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "meterless-app": APP_ID,
    ...(chat ? { "meterless-scope": "user" } : {}),
  };
}

async function timed(url: string, init: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Only a successful model list counts as online.
export async function checkStatus(cfg: Pick<MeterlessConfig, "baseUrl" | "token">): Promise<{ status: ProviderStatus; models: string[]; detail?: string }> {
  try {
    const res = await timed(`${cfg.baseUrl}/models`, { headers: headers(cfg.token) }, 10_000);
    if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [], detail: `HTTP ${res.status}` };
    if (!res.ok) return { status: "offline", models: [], detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { status: "online", models: (body.data ?? []).map((m: { id: string }) => m.id) };
  } catch (err) {
    return { status: "offline", models: [], detail: (err as Error).message };
  }
}

// Scan the usual local ports and return the first runtime that answers /v1/models (even with 401).
export async function autoDetect(token: string): Promise<string | null> {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const port of AUTO_DETECT_PORTS) {
      const baseUrl = `http://${host}:${port}/v1`;
      const { status } = await checkStatus({ baseUrl, token });
      if (status !== "offline") return baseUrl;
    }
  }
  return null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: ChatMessage;
  model: string; // the model the runtime reports it used
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  ms: number;
}

export class ProviderError extends Error {
  constructor(public status: ProviderStatus, message: string) {
    super(message);
  }
}

export async function chat(cfg: MeterlessConfig, messages: ChatMessage[], opts: { tools?: ToolSpec[]; temperature?: number; model?: string; json?: boolean } = {}): Promise<ChatResult> {
  const started = Date.now();
  const body: Record<string, unknown> = { model: opts.model ?? cfg.model, messages, temperature: opts.temperature ?? 0 };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.json) body.response_format = { type: "json_object" };
  let res: Response;
  try {
    res = await timed(`${cfg.baseUrl}/chat/completions`, { method: "POST", headers: headers(cfg.token, true), body: JSON.stringify(body) }, TIMEOUT_MS);
  } catch (err) {
    throw new ProviderError("offline", `Meterless runtime unreachable at ${cfg.baseUrl}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError("unauthorized", `Meterless runtime rejected the token (HTTP ${res.status})`);
  if (!res.ok) throw new ProviderError("online", `Meterless runtime error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return { message: json.choices?.[0]?.message, model: json.model, usage: json.usage, ms: Date.now() - started };
}
