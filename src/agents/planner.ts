// Planner agent. Sets the approach for a company, and after each evaluation decides who handles
// each open issue: the researcher, the activity analyst, or accept it as "not reported".
import { sicFlag } from "./activity.ts";
import type { RunContext } from "./context.ts";
import type { Issue } from "./evaluator.ts";
import { callJson } from "./llm.ts";

const AGENT = "planner" as const;

export interface Plan {
  approach: string;
  watch_for: string[];
}

export async function plan(ctx: RunContext): Promise<Plan> {
  const prior = ctx.evidence.previous(ctx.company.ticker, ctx.runId).filter((e) => e.kind !== "note").slice(-8);
  const flag = sicFlag(ctx.profile.sic);
  const p = await callJson<Plan>(
    `You are the Planner agent in Mizan, a Shariah stock-screening system. A screen needs (1) a business-activity assessment from the company's 10-K and (2) financial ratios from SEC data served through Zetaris: interest-bearing debt, cash and interest-bearing securities, receivables, total assets, revenue, interest income and market cap. Write a short approach for this company and list what is likely to be hard (e.g. banks report debt differently, companies with captive finance arms, multiple share classes, non-calendar fiscal years).
JSON shape: {"approach": "<2-3 sentences>", "watch_for": ["...", "..."]}`,
    `Company: ${ctx.company.name} (${ctx.company.ticker}), SEC industry ${ctx.profile.sic} ${ctx.profile.sicDescription}${flag ? ` [flag: ${flag}]` : ""}.\n${prior.length ? `Memory from earlier screens of this company:\n${prior.map((e) => `- ${e.content}`).join("\n")}` : "No earlier screens of this company in memory."}`,
    { agent: AGENT, trace: ctx.trace, tier: "deep", purpose: "plan the screen" },
    (v) => (typeof v.approach === "string" && Array.isArray(v.watch_for) ? null : "need approach and watch_for"),
  );
  ctx.trace.emit(AGENT, "plan", p.approach, { data: p });
  return p;
}

export interface Assignment {
  agent: "researcher" | "activity-analyst" | "accept";
  metric: string;
  instruction: string;
}

export async function revise(ctx: RunContext, issues: Issue[], round: number, maxRounds: number): Promise<Assignment[]> {
  const fallback = (): Assignment[] => issues.map((i) => ({ agent: i.kind === "activity" ? "activity-analyst" : "researcher", metric: i.metric, instruction: i.problem }));
  try {
    const reply = await callJson<{ assignments: Assignment[] }>(
      `You are the Planner agent in Mizan. The evaluator raised issues with the evidence. For each issue decide who handles it:
- "researcher": find or correct a financial figure (Zetaris first, then the company's SEC XBRL data).
- "activity-analyst": re-assess business activity from the 10-K.
- "accept": stop chasing it because it is genuinely not reported or immaterial (e.g. interest income a company does not report separately). Only accept after a researcher has already tried, or in the final round.
Give a one-sentence instruction for each. This is round ${round} of at most ${maxRounds}.
JSON shape: {"assignments": [{"agent": "researcher"|"activity-analyst"|"accept", "metric": "...", "instruction": "..."}]}`,
      `Company: ${ctx.company.name} (${ctx.company.ticker}), industry ${ctx.profile.sicDescription}.\nIssues:\n${issues.map((i) => `- [${i.kind}] ${i.metric}: ${i.problem}`).join("\n")}`,
      { agent: AGENT, trace: ctx.trace, tier: "deep", purpose: `revise plan (round ${round})` },
      (v) => (Array.isArray(v.assignments) ? null : "assignments must be an array"),
    );
    const valid = reply.assignments.filter((a) => ["researcher", "activity-analyst", "accept"].includes(a.agent) && issues.some((i) => i.metric === a.metric));
    // Any issue the model skipped still gets handled.
    for (const i of issues) if (!valid.some((a) => a.metric === i.metric)) valid.push(...fallback().filter((a) => a.metric === i.metric));
    for (const a of valid) ctx.trace.emit(AGENT, "decision", `${a.metric} -> ${a.agent}: ${a.instruction}`);
    return valid;
  } catch (err) {
    ctx.trace.emit(AGENT, "error", `Planner fell back to default routing: ${(err as Error).message}`);
    return fallback();
  }
}
