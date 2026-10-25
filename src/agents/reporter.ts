// Risk agent (escalation for borderline or unquantifiable cases) and Reporter agent (the
// plain-language verdict). Both cite evidence IDs, which are checked against the evidence store.
import type { StandardResult } from "../calc/screen.ts";
import { pct } from "../calc/screen.ts";
import type { RunContext } from "./context.ts";
import { callJson } from "./llm.ts";

export interface Escalation {
  question_for_scholar: string;
  why: string;
}

function resultLines(results: StandardResult[]): string {
  return results
    .map((r) => `${r.standardName}: ${r.verdict}\n${[r.business, ...r.ratios].map((t) => `  - ${t.label}: ${pct(t.ratio)} (limit ${pct(t.limit)}) ${t.status} [evidence ${t.evidenceIds.join(", ") || "none"}]`).join("\n")}`)
    .join("\n");
}

export async function escalate(ctx: RunContext, results: StandardResult[]): Promise<Escalation> {
  const reply = await callJson<Escalation>(
    `You are the Risk agent in Mizan, a Shariah stock-screening system. The screen could not reach a clean verdict. Write the single most useful question a Shariah scholar or advisor should answer to resolve it, and why. Be specific to this company; do not issue a ruling yourself.
JSON shape: {"question_for_scholar": "...", "why": "..."}`,
    `Company: ${ctx.company.name} (${ctx.company.ticker}), industry ${ctx.profile.sicDescription}\n${resultLines(results)}`,
    { agent: "risk", trace: ctx.trace, tier: "deep", purpose: "escalate for scholar review" },
    (v) => (v.question_for_scholar ? null : "question_for_scholar is required"),
  );
  ctx.trace.emit("risk", "decision", `Escalated: ${reply.question_for_scholar}`, { data: reply });
  return reply;
}

export interface Narrative {
  headline: string;
  explanation: string;
  key_points: { text: string; evidence: string[] }[];
}

// Used when the model is unavailable: a plain summary built only from the calculator's results.
export function fallbackNarrative(ctx: RunContext, results: StandardResult[], purificationRate: number | null): Narrative {
  const verdicts = results.map((r) => `${r.standardName.split(" ")[0]}: ${r.verdict.replace("_", " ").toLowerCase()}`).join(", ");
  const worst = results.find((r) => r.verdict === "NON_COMPLIANT") ?? results.find((r) => r.verdict === "NEEDS_REVIEW") ?? results[0];
  const key = [worst.business, ...worst.ratios].filter((t) => t.status !== "PASS");
  return {
    headline: `${ctx.company.name}: ${verdicts}`,
    explanation: `${key.length ? worst.reasons.join(". ") + "." : "Every business-activity and financial-ratio test passed."} Purification rate: ${pct(purificationRate)}. This is a screening result, not a fatwa.`,
    key_points: [worst.business, ...worst.ratios].map((t) => ({ text: `${t.label}: ${pct(t.ratio)} (limit ${pct(t.limit)}) ${t.status}`, evidence: t.evidenceIds })),
  };
}

export async function report(ctx: RunContext, results: StandardResult[], purificationRate: number | null): Promise<Narrative> {
  // Only the evidence the verdict rests on (plus activity quotes), kept short for the model.
  const used = new Set(results.flatMap((r) => [r.business, ...r.ratios].flatMap((t) => t.evidenceIds)));
  const evidence = ctx.evidence
    .find(ctx.company.ticker, ctx.runId)
    .filter((e) => used.has(e.id) || e.kind === "quote" || e.metric === "sic")
    .map((e) => ({ ...e, content: e.content.slice(0, 220) }));
  const known = new Set(evidence.map((e) => e.id));
  const reply = await callJson<Narrative>(
    `You are the Reporter agent in Mizan. Explain the screening result to a retail Muslim investor in plain English: what the verdict is, the main reason, and what (if anything) is uncertain. Mention the purification rate if dividends are involved. Cite evidence IDs (like "mem-12") for every key point, using only IDs listed below. Never invent numbers. Mizan gives a screening result, not a fatwa.
JSON shape: {"headline": "<max 12 words>", "explanation": "<3-4 sentences>", "key_points": [{"text": "...", "evidence": ["mem-..."]}]}`,
    `Company: ${ctx.company.name} (${ctx.company.ticker})\n${resultLines(results)}\nPurification rate: ${pct(purificationRate)}\nEvidence:\n${evidence.map((e) => `${e.id}: ${e.content}`).join("\n")}`,
    { agent: "reporter", trace: ctx.trace, tier: "deep", purpose: "write the verdict" },
    (v) => (v.headline && Array.isArray(v.key_points) ? null : "need headline and key_points"),
  );
  // Drop citations that do not exist.
  for (const k of reply.key_points) k.evidence = (k.evidence ?? []).filter((id) => known.has(id));
  ctx.trace.emit("reporter", "result", reply.headline, { data: reply, refs: reply.key_points.flatMap((k) => k.evidence) });
  return reply;
}
