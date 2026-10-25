// Evaluator agent. Deterministic checks first (missing, stale, conflicting, implausible evidence),
// then a Nemotron review for anything that looks wrong for this kind of company. It either approves
// the evidence set or returns issues that send the planner and researcher round again.
import type { Evidence } from "../memory/evidence.ts";
import { REQUIRED_METRICS, type RunContext } from "./context.ts";
import { callJson } from "./llm.ts";

const AGENT = "evaluator" as const;

export interface Issue {
  metric: string;
  kind: "missing" | "stale" | "conflict" | "implausible" | "activity";
  problem: string;
  evidenceIds: string[];
}

const BALANCE = new Set(["totalAssets", "interestBearingDebt", "cash", "interestBearingSecurities", "receivables", "sharesOutstanding"]);
const ANNUAL = new Set(["totalRevenue", "interestIncome"]);

const monthsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (30.44 * 86_400_000);

export function currentValue(ctx: RunContext, metric: string): Evidence | undefined {
  return ctx.evidence
    .find(ctx.company.ticker, ctx.runId, metric)
    .filter((e) => e.value !== undefined && e.kind !== "note")
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
}

const gaveUp = (ctx: RunContext, metric: string) => ctx.evidence.find(ctx.company.ticker, ctx.runId, metric).some((e) => e.kind === "note");

export function deterministicChecks(ctx: RunContext): Issue[] {
  const issues: Issue[] = [];
  const v = (m: string) => currentValue(ctx, m);

  for (const m of REQUIRED_METRICS) {
    const e = v(m);
    if (!e) {
      if (!gaveUp(ctx, m)) issues.push({ metric: m, kind: "missing", problem: `No value found for ${m}`, evidenceIds: [] });
      continue;
    }
    if (e.periodEnd && BALANCE.has(m) && monthsBetween(e.periodEnd, ctx.today) > 15) {
      issues.push({ metric: m, kind: "stale", problem: `${m} is from ${e.periodEnd}, more than 15 months old`, evidenceIds: [e.id] });
    }
    if (e.periodEnd && ANNUAL.has(m) && monthsBetween(e.periodEnd, ctx.today) > 21) {
      issues.push({ metric: m, kind: "stale", problem: `${m} is for the year ending ${e.periodEnd}; a newer fiscal year should exist`, evidenceIds: [e.id] });
    }
  }

  // Two live figures for the same metric that disagree by more than 5%.
  for (const m of REQUIRED_METRICS) {
    const vals = ctx.evidence.find(ctx.company.ticker, ctx.runId, m).filter((e) => e.value !== undefined && e.kind !== "note");
    for (let i = 0; i < vals.length; i++)
      for (let j = i + 1; j < vals.length; j++) {
        const a = vals[i].value!, b = vals[j].value!;
        if (Math.max(a, b) > 0 && Math.abs(a - b) / Math.max(a, b) > 0.05) {
          ctx.evidence.conflict(AGENT, vals[i].id, vals[j].id, `${m}: ${a} vs ${b}`);
          issues.push({ metric: m, kind: "conflict", problem: `Two sources disagree on ${m} (${a} vs ${b}); decide which is the correct, latest figure`, evidenceIds: [vals[i].id, vals[j].id] });
        }
      }
  }

  const assets = v("totalAssets")?.value;
  for (const m of ["interestBearingDebt", "cash", "receivables"]) {
    const e = v(m);
    if (assets && e?.value !== undefined && e.value > assets) issues.push({ metric: m, kind: "implausible", problem: `${m} (${e.value}) exceeds total assets (${assets})`, evidenceIds: [e.id] });
  }

  const activity = ctx.evidence.find(ctx.company.ticker, ctx.runId, "nonCompliantRevenueShare");
  if (!activity.length) issues.push({ metric: "nonCompliantRevenueShare", kind: "activity", problem: "Business activity has not been assessed", evidenceIds: [] });

  return issues;
}

interface Review {
  approve: boolean;
  issues: { metric: string; problem: string }[];
}

// Nemotron review of the assembled figures: catches values that are technically present but wrong
// for this company (e.g. debt that only covers one bond, revenue that is a single segment).
export async function review(ctx: RunContext, round: number): Promise<Issue[]> {
  const rows = [...REQUIRED_METRICS, "interestBearingSecurities", "sharesOutstanding"].map((m) => {
    const e = currentValue(ctx, m);
    return `- ${m}: ${e ? `${e.value} (period ${e.periodEnd ?? "n/a"}; ${e.sourceLabel}; ${e.id})` : gaveUp(ctx, m) ? "not reported (researcher gave up)" : "missing"}`;
  });
  const activity = currentValue(ctx, "nonCompliantRevenueShare") ?? ctx.evidence.find(ctx.company.ticker, ctx.runId, "nonCompliantRevenueShare")[0];
  ctx.evidence.read(AGENT, ctx.evidence.find(ctx.company.ticker, ctx.runId).map((e) => e.id), `evaluation round ${round}`);

  const reply = await callJson<Review>(
    `You are the Evaluator agent in Mizan, a Shariah stock-screening system. You check the evidence other agents gathered before any verdict is issued. Flag a figure only if it is clearly inconsistent with the others or with what this company is (e.g. interest-bearing debt that is implausibly small for a heavily indebted business, revenue far below what the asset base suggests, a value that looks like one segment instead of the total). Do not flag figures merely because they are large or small. Today is ${ctx.today}.
JSON shape: {"approve": true|false, "issues": [{"metric": "<one of the metric names>", "problem": "<what is wrong and what to look for>"}]}. At most 2 issues.`,
    `Company: ${ctx.company.name} (${ctx.company.ticker}), SEC industry ${ctx.profile.sic} ${ctx.profile.sicDescription}\nEvaluation round ${round}.\nFigures:\n${rows.join("\n")}\n- business activity: ${activity?.content ?? "not assessed"}`,
    { agent: AGENT, trace: ctx.trace, tier: "deep", purpose: `review evidence (round ${round})` },
    (v) => (typeof v.approve === "boolean" && Array.isArray(v.issues) ? null : "need approve:boolean and issues:array"),
  );
  return reply.issues
    .filter((i) => [...REQUIRED_METRICS, "interestBearingSecurities"].includes(i.metric))
    .slice(0, 2)
    .map((i) => ({ metric: i.metric, kind: "implausible" as const, problem: `Evaluator review: ${i.problem}`, evidenceIds: currentValue(ctx, i.metric) ? [currentValue(ctx, i.metric)!.id] : [] }));
}
