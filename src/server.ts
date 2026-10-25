// Mizan web server: serves the UI and an API that runs screens and streams agent events (SSE).
//   npm run dev   ->  http://localhost:5050
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.ts";
import { runScreen, getEvidenceStore, type ScreenReport } from "./agents/orchestrator.ts";
import type { TraceEvent } from "./agents/trace.ts";
import { checkStatus, loadConfig } from "./llm/meterless.ts";
import { runSql } from "./data/zetaris.ts";
import { MODELS } from "./agents/llm.ts";
import { DEMO_UNIVERSE } from "./data/universe.ts";

const PORT = Number(process.env.PORT ?? 5050);
const WEB = path.join(ROOT, "web");
const RUNS = path.join(ROOT, "runs");

interface LiveRun {
  id: string;
  ticker: string;
  events: TraceEvent[];
  clients: Set<http.ServerResponse>;
  report?: ScreenReport;
  error?: string;
}
const live = new Map<string, LiveRun>();

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startRun(ticker: string): LiveRun {
  const run: LiveRun = { id: "", ticker, events: [], clients: new Set() };
  const listener = (e: TraceEvent) => {
    if (!run.id) {
      run.id = e.runId;
      live.set(run.id, run);
    }
    run.events.push(e);
    for (const c of run.clients) send(c, "trace", e);
  };
  const done = runScreen(ticker, { listeners: [listener] })
    .then((r) => {
      run.report = r;
      for (const c of run.clients) send(c, "report", r);
    })
    .catch((err) => {
      run.error = (err as Error).message;
      for (const c of run.clients) send(c, "failed", { error: run.error });
    })
    .finally(() => {
      for (const c of run.clients) c.end();
      run.clients.clear();
    });
  void done;
  return run;
}

// Layer status for the header: proves each sponsor layer is live, without exposing keys.
async function status() {
  const out: Record<string, unknown> = {};
  await Promise.all([
    checkStatus(loadConfig())
      .then((s) => (out.meterless = { status: s.status, endpoint: loadConfig().baseUrl, models: { fast: MODELS.fast(), deep: MODELS.deep() }, nemotron: s.models.filter((m) => m.includes("nemotron")).length }))
      .catch((e) => (out.meterless = { status: "offline", detail: (e as Error).message })),
    runSql("SHOW LIGHTNING DATABASES", 20)
      .then((r) => (out.zetaris = { status: "online", databases: r.rows.map((x) => x.name) }))
      .catch((e) => (out.zetaris = { status: "offline", detail: (e as Error).message.slice(0, 120) })),
  ]);
  const store = getEvidenceStore();
  out.hmem = { status: "online", records: store.hmem.store.all().length, ledger: store.hmem.ledger.all().length };
  return out;
}

function recentReports(limit = 12) {
  if (!fs.existsSync(RUNS)) return [];
  return fs
    .readdirSync(RUNS)
    .filter((f) => f.endsWith(".report.json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RUNS, f), "utf8")) as ScreenReport)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map((r) => ({ runId: r.runId, ticker: r.ticker, company: r.company, verdicts: r.results.map((x) => ({ standard: x.standardId, verdict: x.verdict })), at: r.finishedAt }));
}

function loadRun(id: string): { events: TraceEvent[]; report?: ScreenReport } | null {
  const run = live.get(id);
  if (run) return { events: run.events, report: run.report };
  const trace = path.join(RUNS, `${path.basename(id)}.jsonl`);
  if (!fs.existsSync(trace)) return null;
  const events = fs.readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const rep = path.join(RUNS, `${path.basename(id)}.report.json`);
  return { events, report: fs.existsSync(rep) ? JSON.parse(fs.readFileSync(rep, "utf8")) : undefined };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "POST" && p === "/api/screen") {
      const { ticker } = await readBody(req);
      if (!/^[A-Za-z.\-]{1,12}$/.test(ticker ?? "")) return json(res, 400, { error: "Enter a ticker, e.g. AAPL or DANGCEM" });
      const run = startRun(String(ticker).toUpperCase());
      // Wait for the first event so the run id exists.
      for (let i = 0; i < 100 && !run.id && !run.error; i++) await new Promise((r) => setTimeout(r, 50));
      if (run.error) return json(res, 400, { error: run.error });
      return json(res, 202, { runId: run.id });
    }
    let m = p.match(/^\/api\/screen\/([\w-]+)\/events$/);
    if (m) {
      const run = live.get(m[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      if (!run) {
        const past = loadRun(m[1]);
        if (!past) return send(res, "failed", { error: "Unknown run" }), res.end();
        // ?pace=ms replays a saved run event by event, as it looked live (used for demos).
        const pace = Math.min(2000, Math.max(0, Number(url.searchParams.get("pace") ?? 0)));
        for (const e of past.events) {
          if (res.destroyed) return;
          send(res, "trace", e);
          if (pace) await new Promise((r) => setTimeout(r, e.type === "llm" ? pace * 2 : pace));
        }
        if (past.report) send(res, "report", past.report);
        return res.end();
      }
      run.events.forEach((e) => send(res, "trace", e));
      if (run.report) return send(res, "report", run.report), res.end();
      if (run.error) return send(res, "failed", { error: run.error }), res.end();
      run.clients.add(res);
      req.on("close", () => run.clients.delete(res));
      return;
    }
    m = p.match(/^\/api\/screen\/([\w-]+)$/);
    if (m) {
      const r = loadRun(m[1]);
      return r ? json(res, 200, r) : json(res, 404, { error: "Unknown run" });
    }
    m = p.match(/^\/api\/evidence\/(mem-\d+)$/);
    if (m) {
      const store = getEvidenceStore();
      const e = store.get(m[1]);
      return e ? json(res, 200, { evidence: e, ledger: store.history(m[1]) }) : json(res, 404, { error: "Unknown evidence" });
    }
    if (p === "/api/status") return json(res, 200, await status());
    if (p === "/api/runs") return json(res, 200, recentReports());
    if (p === "/api/universe") return json(res, 200, DEMO_UNIVERSE);

    // Static files.
    const file = path.join(WEB, p === "/" ? "index.html" : path.normalize(p).replace(/^([/\\])+/, ""));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, () => console.log(`Mizan running at http://localhost:${PORT}`));
