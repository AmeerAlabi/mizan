// Deterministic screening maths. LLM agents never compute ratios; they call this.
import { BORDERLINE_MARGIN, type Denominator, type Metric, type Standard } from "./standards.ts";

// Every input carries the id of the evidence it came from, so results stay traceable.
export interface Sourced {
  value: number;
  evidenceIds: string[];
}

export interface ScreenInputs {
  marketCap?: Sourced;
  totalAssets?: Sourced;
  totalRevenue?: Sourced;
  interestBearingDebt?: Sourced;
  cash?: Sourced;
  interestBearingSecurities?: Sourced;
  receivables?: Sourced;
  interestIncome?: Sourced;
  // Share of revenue from non-compliant activities, as estimated by the activity analyst.
  // undefined = not assessed; null = assessed but could not be quantified.
  nonCompliantRevenueShare?: { value: number | null; evidenceIds: string[]; rationale: string };
}

export type TestStatus = "PASS" | "BORDERLINE" | "FAIL" | "MISSING";

export interface TestResult {
  id: string;
  label: string;
  status: TestStatus;
  ratio: number | null;
  limit: number;
  numerator: number | null;
  denominator: number | null;
  evidenceIds: string[];
  missing: string[];
}

export type Verdict = "COMPLIANT" | "NON_COMPLIANT" | "NEEDS_REVIEW";

export interface StandardResult {
  standardId: string;
  standardName: string;
  verdict: Verdict;
  business: TestResult;
  ratios: TestResult[];
  reasons: string[];
  purificationRate: number | null;
}

function sum(parts: (Sourced | undefined)[], names: string[]): { value: number | null; evidenceIds: string[]; missing: string[] } {
  const missing = names.filter((_, i) => parts[i] === undefined);
  if (missing.length === parts.length) return { value: null, evidenceIds: [], missing };
  // A component that is absent from filings counts as zero only if at least one other part exists;
  // the missing names are still reported so the evaluator can decide whether that is acceptable.
  const present = parts.filter((p): p is Sourced => p !== undefined);
  return { value: present.reduce((a, p) => a + p.value, 0), evidenceIds: present.flatMap((p) => p.evidenceIds), missing };
}

function metricValue(metric: Metric, i: ScreenInputs) {
  switch (metric) {
    case "interestBearingDebt":
      return sum([i.interestBearingDebt], ["interestBearingDebt"]);
    case "cashAndInterestBearingSecurities":
      return sum([i.cash, i.interestBearingSecurities], ["cash", "interestBearingSecurities"]);
    case "cashSecuritiesAndReceivables":
      return sum([i.cash, i.interestBearingSecurities, i.receivables], ["cash", "interestBearingSecurities", "receivables"]);
    case "nonCompliantIncome":
      return sum([i.interestIncome], ["interestIncome"]);
  }
}

function denominatorValue(d: Denominator, i: ScreenInputs): Sourced | undefined {
  return d === "marketCap" ? i.marketCap : d === "totalAssets" ? i.totalAssets : i.totalRevenue;
}

export function classify(ratio: number, limit: number): TestStatus {
  if (ratio >= limit) return "FAIL";
  if (ratio >= limit * (1 - BORDERLINE_MARGIN)) return "BORDERLINE";
  return "PASS";
}

function businessTest(std: Standard, i: ScreenInputs): TestResult {
  const base = { id: "business", label: "Revenue from non-compliant activities", limit: std.businessActivityLimit, numerator: null, denominator: null };
  const share = i.nonCompliantRevenueShare;
  if (!share || share.value === null) {
    return { ...base, status: "MISSING", ratio: null, evidenceIds: share?.evidenceIds ?? [], missing: ["nonCompliantRevenueShare"] };
  }
  return { ...base, status: classify(share.value, std.businessActivityLimit), ratio: share.value, evidenceIds: share.evidenceIds, missing: [] };
}

export function screen(std: Standard, i: ScreenInputs): StandardResult {
  const business = businessTest(std, i);
  const ratios: TestResult[] = std.ratios.map((rule) => {
    const num = metricValue(rule.metric, i);
    const den = denominatorValue(rule.denominator, i);
    const missing = [...num.missing, ...(den ? [] : [rule.denominator])];
    if (num.value === null || !den || den.value <= 0) {
      return { id: rule.id, label: rule.label, status: "MISSING", ratio: null, limit: rule.limit, numerator: num.value, denominator: den?.value ?? null, evidenceIds: [...num.evidenceIds, ...(den?.evidenceIds ?? [])], missing };
    }
    const ratio = num.value / den.value;
    return { id: rule.id, label: rule.label, status: classify(ratio, rule.limit), ratio, limit: rule.limit, numerator: num.value, denominator: den.value, evidenceIds: [...num.evidenceIds, ...den.evidenceIds], missing };
  });

  const all = [business, ...ratios];
  const reasons: string[] = [];
  for (const t of all) {
    if (t.status === "FAIL") reasons.push(`${t.label}: ${pct(t.ratio)} is at or above the ${pct(t.limit)} limit`);
    if (t.status === "BORDERLINE") reasons.push(`${t.label}: ${pct(t.ratio)} is close to the ${pct(t.limit)} limit`);
    if (t.status === "MISSING") reasons.push(`${t.label}: missing ${t.missing.join(", ")}`);
  }

  let verdict: Verdict;
  if (all.some((t) => t.status === "FAIL")) verdict = "NON_COMPLIANT";
  else if (all.some((t) => t.status === "MISSING" || t.status === "BORDERLINE")) verdict = "NEEDS_REVIEW";
  else verdict = "COMPLIANT";

  return { standardId: std.id, standardName: std.name, verdict, business, ratios, reasons, purificationRate: purificationRate(i) };
}

// Share of each dividend to give to charity: non-compliant income over total revenue.
export function purificationRate(i: ScreenInputs): number | null {
  if (!i.totalRevenue || i.totalRevenue.value <= 0) return null;
  const interest = i.interestIncome?.value ?? 0;
  const activity = i.nonCompliantRevenueShare?.value ?? 0;
  return Math.min(1, interest / i.totalRevenue.value + activity);
}

export function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(2)}%`;
}
