// Screen one company from the terminal and watch the agents work.
//   npm run screen -- AAPL
import { runScreen } from "../src/agents/orchestrator.ts";
import type { TraceEvent } from "../src/agents/trace.ts";
import { pct } from "../src/calc/screen.ts";

const ticker = process.argv[2];
if (!ticker) {
  console.error("usage: npm run screen -- <TICKER>");
  process.exit(2);
}

const color: Record<string, string> = { orchestrator: "90", planner: "35", researcher: "36", "activity-analyst": "33", calculator: "32", evaluator: "31", risk: "95", reporter: "34" };
const show = (e: TraceEvent) => {
  if (e.type === "llm") return console.log(`\x1b[90m      · ${e.agent} called ${e.model} (${e.ms} ms): ${e.summary}\x1b[0m`);
  const round = e.round ? `r${e.round}` : "  ";
  const refs = e.refs?.length ? `  \x1b[90m[${e.refs.slice(0, 4).join(", ")}]\x1b[0m` : "";
  console.log(`${round} \x1b[${color[e.agent] ?? "0"}m${e.agent.padEnd(16)}\x1b[0m ${e.type.padEnd(8)} ${e.summary.slice(0, 220)}${refs}`);
};

const r = await runScreen(ticker, { listeners: [show] });
console.log(`\n=== ${r.company} (${r.ticker}) · ${r.industry} · ${r.rounds} round(s) ===`);
for (const s of r.results) {
  console.log(`\n${s.standardName}: ${s.verdict}`);
  for (const t of [s.business, ...s.ratios]) console.log(`  ${t.status.padEnd(10)} ${t.label.padEnd(52)} ${pct(t.ratio).padStart(8)}  limit ${pct(t.limit)}`);
}
console.log(`\nPurification rate: ${pct(r.purificationRate)}`);
if (r.narrative) console.log(`\n${r.narrative.headline}\n${r.narrative.explanation}`);
if (r.escalation) console.log(`\nQuestion for a scholar: ${r.escalation.question_for_scholar}`);
console.log(`\nTrace: runs/${r.runId}.jsonl   Report: runs/${r.runId}.report.json`);
