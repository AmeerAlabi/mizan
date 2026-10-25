// Runs one screen: plan -> research + activity analysis -> evaluate -> (re-plan -> re-research)* ->
// calculate -> escalate if needed -> report. The loop stops when the evaluator approves or after
// maxRounds; unresolved gaps then surface as NEEDS_REVIEW instead of a guess.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "../env.ts";
import { lookupTicker, submissions } from "../data/sec.ts";
import { asCompany, asProfile, isNgxTicker, lookupNgx } from "../data/ngx.ts";
import { purificationRate, screen, type ScreenInputs, type StandardResult } from "../calc/screen.ts";
import { STANDARDS } from "../calc/standards.ts";
import { EvidenceStore } from "../memory/evidence.ts";
import { Trace, type Listener } from "./trace.ts";
import type { RunContext } from "./context.ts";
import { gatherFromZetaris, gatherMarketData, investigate } from "./researcher.ts";
import { analyseActivity } from "./activity.ts";
import { currentValue, deterministicChecks, review, type Issue } from "./evaluator.ts";
import { plan, revise } from "./planner.ts";
import { escalate, fallbackNarrative, report, type Escalation, type Narrative } from "./reporter.ts";

export interface ScreenReport {
  runId: string;
  ticker: string;
  market: "US" | "NGX";
  currency: "USD" | "NGN";
  company: string;
  cik: string;
  industry: string;
  rounds: number;
  results: StandardResult[];
  purificationRate: number | null;
  narrative: Narrative | null;
  escalation: Escalation | null;
  unresolved: Issue[];
  startedAt: string;
  finishedAt: string;
}

let sharedStore: EvidenceStore | null = null;

export function getEvidenceStore(): EvidenceStore {
  return (sharedStore ??= new EvidenceStore());
}

export async function runScreen(ticker: string, opts: { listeners?: Listener[]; maxRounds?: number; standards?: string[] } = {}): Promise<ScreenReport> {
  const maxRounds = opts.maxRounds ?? 3;
  const startedAt = new Date().toISOString();
  const runId = `${ticker.toUpperCase()}-${startedAt.replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 4)}`;
  const trace = new Trace(runId, opts.listeners);
  const evidence = (sharedStore ??= new EvidenceStore());

  trace.emit("orchestrator", "start", `Screening ${ticker.toUpperCase()}`);
  // Nigerian Exchange companies are profiled from Zetaris; US companies from SEC EDGAR.
  const ngx = isNgxTicker(ticker) ? await lookupNgx(ticker) : null;
  const company = ngx ? asCompany(ngx) : await lookupTicker(ticker);
  const profile = ngx ? asProfile(ngx) : await submissions(company.cik);
  const ctx: RunContext = { runId, company, profile, evidence, trace, today: startedAt.slice(0, 10), market: ngx ? "NGX" : "US", currency: ngx ? "NGN" : "USD", ngx: ngx ?? undefined };
  if (ngx) trace.emit("orchestrator", "decision", `${ngx.name} is listed on the Nigerian Exchange: using its audited filing data registered in Zetaris (mizan.ngx_*)`);

  await plan(ctx).catch((e) => trace.emit("planner", "error", `Planning model unavailable (${(e as Error).message.slice(0, 80)}); using the standard plan: assess activity from the 10-K, pull ratios from Zetaris, evaluate`));

  // Round 1: data and activity in parallel.
  trace.round = 1;
  await Promise.all([
    gatherFromZetaris(ctx).catch((e) => trace.emit("researcher", "error", `Zetaris query failed: ${(e as Error).message}`)),
    gatherMarketData(ctx).catch((e) => trace.emit("researcher", "error", `Market data failed: ${(e as Error).message}`)),
    analyseActivity(ctx).catch((e) => trace.emit("activity-analyst", "error", `Activity analysis failed: ${(e as Error).message}`)),
  ]);

  let unresolved: Issue[] = [];
  const reviewed = new Set<string>();
  // Figures the evaluator doubted, by metric -> the evidence id it doubted.
  const doubted = new Map<string, Issue>();
  for (let round = 1; round <= maxRounds; round++) {
    trace.round = round;
    let issues = deterministicChecks(ctx);

    // If the business itself clearly fails, missing financial figures cannot change the verdict:
    // stop chasing them and say so, instead of spending rounds on data that does not matter.
    const activityNow = currentValue(ctx, "nonCompliantRevenueShare");
    if (activityNow?.value !== undefined && activityNow.value >= 0.5 && activityNow.confidence >= 0.6) {
      const moot = issues.filter((i) => i.kind === "missing" && i.metric !== "nonCompliantRevenueShare");
      if (moot.length) {
        issues = issues.filter((i) => !moot.includes(i));
        for (const i of moot) evidence.add("planner", { ticker: company.ticker, kind: "note", metric: i.metric, content: `Not pursued: business activity already fails (${(activityNow.value * 100).toFixed(0)}% non-compliant revenue), so ${i.metric} cannot change the verdict`, source: "agent:planner", sourceLabel: "Planner decision" }, runId);
        trace.emit("planner", "decision", `Business activity already fails (${(activityNow.value * 100).toFixed(0)}% non-compliant revenue); not chasing ${moot.map((i) => i.metric).join(", ")} because they cannot change the verdict`, { refs: [activityNow.id] });
      }
    }
    for (const i of issues) trace.emit("evaluator", "issue", `[${i.kind}] ${i.problem}`, { refs: i.evidenceIds });
    for (const i of issues.filter((x) => x.kind === "stale")) for (const id of i.evidenceIds) evidence.reject("evaluator", id, i.problem);

    // The model review runs once the deterministic checks are clean, and never re-flags a metric it already raised.
    if (!issues.length) {
      try {
        const extra = (await review(ctx, round)).filter((i) => !reviewed.has(i.metric));
        extra.forEach((i) => (reviewed.add(i.metric), doubted.set(i.metric, i)));
        for (const i of extra) trace.emit("evaluator", "issue", `[${i.kind}] ${i.problem}`, { refs: i.evidenceIds });
        issues.push(...extra);
      } catch (err) {
        trace.emit("evaluator", "error", `Review skipped: ${(err as Error).message}`);
      }
    }

    if (!issues.length) {
      trace.emit("evaluator", "decision", `Approved the evidence in round ${round}`);
      unresolved = [];
      break;
    }
    unresolved = issues;
    if (round === maxRounds) {
      trace.emit("evaluator", "decision", `Round limit reached with ${issues.length} open issue(s); they will be reported, not guessed`);
      break;
    }

    const assignments = await revise(ctx, issues, round, maxRounds);
    trace.round = round + 1;
    const research = issues.filter((i) => assignments.some((a) => a.agent === "researcher" && a.metric === i.metric));
    const work: Promise<unknown>[] = [];
    if (research.length) work.push(investigate(ctx, research.map((i) => ({ ...i, problem: `${i.problem}. Planner: ${assignments.find((a) => a.metric === i.metric)?.instruction}` }))).catch((e) => trace.emit("researcher", "error", (e as Error).message)));
    if (assignments.some((a) => a.agent === "activity-analyst")) work.push(analyseActivity(ctx).catch((e) => trace.emit("activity-analyst", "error", (e as Error).message)));
    for (const a of assignments.filter((x) => x.agent === "accept")) {
      evidence.add("planner", { ticker: company.ticker, kind: "note", metric: a.metric, content: `Accepted as not reported: ${a.instruction}`, source: "agent:planner", sourceLabel: "Planner decision" }, runId);
      trace.emit("planner", "decision", `Accepted ${a.metric} as not reported`);
    }
    await Promise.all(work);
  }

  // A doubted figure that nobody replaced must not decide the verdict: drop it, so that test reads
  // "Needs review" instead of passing on a number the evaluator rejected.
  const excluded = new Set<string>();
  for (const [metric, issue] of doubted) {
    const cur = currentValue(ctx, metric);
    if (cur && issue.evidenceIds.includes(cur.id)) {
      excluded.add(metric);
      evidence.reject("evaluator", cur.id, issue.problem);
      if (!unresolved.some((u) => u.metric === metric)) unresolved.push(issue);
      trace.emit("evaluator", "decision", `Not using ${metric}: the doubted figure was not replaced`, { refs: [cur.id] });
    }
  }

  // Interest income that the company does not report separately is treated as immaterial (0),
  // flagged with low confidence so the report says so.
  if (!currentValue(ctx, "interestIncome")) {
    const e = evidence.add("calculator" as never, { ticker: company.ticker, kind: "derived", metric: "interestIncome", value: 0, content: `${company.name} does not report interest income separately; treated as immaterial (0) for the income test`, source: "agent:calculator:assumption", sourceLabel: "Assumption: interest income not separately reported", confidence: 0.4 }, runId);
    trace.emit("calculator", "decision", e.content, { refs: [e.id] });
    unresolved = unresolved.filter((i) => i.metric !== "interestIncome");
  }

  // Calculator: deterministic maths over the approved evidence.
  trace.round = 0;
  const inputs = buildInputs(ctx, excluded);
  const standards = (opts.standards ?? ["aaoifi", "msci"]).map((s) => STANDARDS[s]).filter(Boolean);
  const results = standards.map((s) => screen(s, inputs));
  for (const r of results) trace.emit("calculator", "result", `${r.standardName}: ${r.verdict}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`, { data: r, refs: [r.business, ...r.ratios].flatMap((t) => t.evidenceIds) });
  const purification = purificationRate(inputs);

  let escalation: Escalation | null = null;
  if (results.some((r) => r.verdict === "NEEDS_REVIEW")) escalation = await escalate(ctx, results).catch(() => null);
  const narrative = await report(ctx, results, purification).catch((e) => {
    trace.emit("reporter", "error", `Model unavailable (${(e as Error).message.slice(0, 80)}); using the calculator summary`);
    const n = fallbackNarrative(ctx, results, purification);
    trace.emit("reporter", "result", n.headline, { data: n });
    return n;
  });

  const out: ScreenReport = {
    runId,
    ticker: company.ticker,
    market: ctx.market,
    currency: ctx.currency,
    company: company.name,
    cik: company.cik,
    industry: ctx.market === "NGX" ? `NGX · ${profile.sicDescription}` : `${profile.sic} ${profile.sicDescription}`,
    rounds: Math.max(...trace.events.map((e) => e.round)),
    results,
    purificationRate: purification,
    narrative,
    escalation,
    unresolved,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ROOT, "runs", `${runId}.report.json`), JSON.stringify(out, null, 2));
  trace.emit("orchestrator", "result", `Done: ${results.map((r) => `${r.standardId.toUpperCase()} ${r.verdict}`).join(", ")}`);
  return out;
}

function buildInputs(ctx: RunContext, excluded: Set<string> = new Set()): ScreenInputs {
  const s = (m: string) => {
    if (excluded.has(m)) return undefined;
    const e = currentValue(ctx, m);
    return e ? { value: e.value!, evidenceIds: [e.id] } : undefined;
  };
  const activity = ctx.evidence.find(ctx.company.ticker, ctx.runId, "nonCompliantRevenueShare").sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    marketCap: s("marketCap"),
    totalAssets: s("totalAssets"),
    totalRevenue: s("totalRevenue"),
    interestBearingDebt: s("interestBearingDebt"),
    cash: s("cash"),
    interestBearingSecurities: s("interestBearingSecurities"),
    receivables: s("receivables"),
    interestIncome: s("interestIncome"),
    nonCompliantRevenueShare: activity ? { value: activity.value ?? null, evidenceIds: [activity.id], rationale: activity.content } : undefined,
  };
}
