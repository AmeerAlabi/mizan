// Smoke test for the three layers. Prints PASS/FAIL only; never prints keys.
//   npm run check
import "../src/env.ts";
import { checkStatus, chat, loadConfig } from "../src/llm/meterless.ts";
import { runSql } from "../src/data/zetaris.ts";
import { lookupTicker } from "../src/data/sec.ts";

const results: [string, string, string][] = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    results.push(["PASS", name, await fn()]);
  } catch (err) {
    results.push(["FAIL", name, (err as Error).message.slice(0, 160)]);
  }
}

await check("Data: SEC EDGAR reachable", async () => {
  const c = await lookupTicker("AAPL");
  return `${c.ticker} -> CIK ${c.cik}`;
});

await check("Data: Zetaris runs SQL over REST", async () => {
  const r = await runSql("SELECT 1 AS one", 1);
  if (String(Object.values(r.rows[0] ?? {})[0]) !== "1") throw new Error(`unexpected reply via ${r.route}`);
  return `route ${r.route}, ${r.ms} ms`;
});

await check("Power: Meterless runtime online", async () => {
  const s = await checkStatus(loadConfig());
  if (s.status !== "online") throw new Error(`${s.status}${s.detail ? ` (${s.detail})` : ""}`);
  return `${s.models.length} models: ${s.models.slice(0, 6).join(", ")}`;
});

await check("Power: model replies through Nightshift", async () => {
  const r = await chat(loadConfig(), [{ role: "user", content: "Reply with the single word: ready" }]);
  return `model=${r.model} in ${r.ms} ms: ${String(r.message?.content).trim().slice(0, 40)}`;
});

for (const [status, name, detail] of results) console.log(`${status} ${name}  ${detail}`);
process.exitCode = results.some(([s]) => s === "FAIL") ? 1 : 0;
