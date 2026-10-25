// Zetaris REST client. Every request carries the API key, the org ID and a fresh request UUID.
// Primary route is the SQL editor endpoint from the participant guide; the documented
// query/sql/start + page API is the fallback.
import { randomUUID } from "node:crypto";
import { env } from "../env.ts";

export interface ZetarisConfig {
  restUrl: string; // ends in /api/v1.0
  orgId: string;
  apiKey: string;
}

export function loadZetaris(): ZetarisConfig {
  return {
    restUrl: env("ZETARIS_REST_URL").replace(/\/+$/, ""),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"),
  };
}

function headers(cfg: ZetarisConfig) {
  return {
    Authorization: `Bearer ${cfg.apiKey}`,
    "X-Org-ID": cfg.orgId,
    "X-Request-ID": randomUUID(),
    "Content-Type": "application/json",
  };
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  sql: string;
  ms: number;
  route: "sql-editor" | "query-api";
}

export class ZetarisError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message);
  }
}

function rowsFromArrays(columns: string[], data: unknown[][]): Record<string, unknown>[] {
  return data.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

async function viaSqlEditor(cfg: ZetarisConfig, sql: string, limit: number): Promise<QueryResult> {
  const started = Date.now();
  const res = await fetch(`${cfg.restUrl}/sql-editor/sqls/run`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit }),
  });
  if (!res.ok) throw new ZetarisError(res.status, `Zetaris ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const data: unknown[] = body.data ?? [];
  const columns: string[] = (body.columns ?? body.schema ?? body.headers ?? []).map((c: any) => (typeof c === "string" ? c : c.name ?? c.columnName));
  const rows = Array.isArray(data[0]) ? rowsFromArrays(columns.length ? columns : (data[0] as unknown[]).map((_, i) => `c${i}`), data as unknown[][]) : (data as Record<string, unknown>[]);
  return { columns: columns.length ? columns : Object.keys(rows[0] ?? {}), rows, sql, ms: Date.now() - started, route: "sql-editor" };
}

async function viaQueryApi(cfg: ZetarisConfig, sql: string, limit: number): Promise<QueryResult> {
  const started = Date.now();
  const res = await fetch(`${cfg.restUrl}/query/sql/start`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ select: sql, pageLimit: Math.min(100, limit) }),
  });
  if (!res.ok) throw new ZetarisError(res.status, `Zetaris ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const first = await res.json();
  const rows: Record<string, unknown>[] = [...(first.records ?? [])];
  for (let page = 2; page <= first.totalPages && rows.length < limit; page++) {
    const p = await fetch(`${cfg.restUrl}/query/sql/page?queryToken=${encodeURIComponent(first.queryToken)}&pageLimit=100&pageNumber=${page}`, { headers: headers(cfg) });
    if (!p.ok) break;
    rows.push(...((await p.json()).records ?? []));
  }
  await fetch(`${cfg.restUrl}/query/sql/close/${encodeURIComponent(first.queryToken)}`, { method: "DELETE", headers: headers(cfg) }).catch(() => {});
  return { columns: Object.keys(rows[0] ?? {}), rows: rows.slice(0, limit), sql, ms: Date.now() - started, route: "query-api" };
}

// Zetaris takes one statement per call.
export async function runSql(sql: string, limit = 200, cfg: ZetarisConfig = loadZetaris()): Promise<QueryResult> {
  const statement = sql.trim().replace(/;+\s*$/, "");
  // Ignore semicolons inside quoted literals when checking for multiple statements.
  if (/;\s*\S/.test(statement.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''"))) throw new Error("Send one SQL statement per call.");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await viaSqlEditor(cfg, statement, limit);
    } catch (err) {
      lastError = err;
      // Bad credentials or bad SQL won't improve on retry.
      if (err instanceof ZetarisError && err.httpStatus >= 400 && err.httpStatus < 500) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // The documented query API only accepts SELECT statements.
  if (/^\s*(select|with)\b/i.test(statement)) return viaQueryApi(cfg, statement, limit);
  throw lastError;
}
