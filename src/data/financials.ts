// Turns SEC company facts into the figures the screen needs, each with full provenance.
// Balance-sheet items are anchored to one reporting date so they come from the same filing;
// income items use the latest full fiscal year from a 10-K.

export interface XbrlFact {
  val: number;
  start?: string;
  end: string;
  fy?: number;
  fp?: string;
  form: string;
  accn: string;
  filed: string;
}

export interface FinancialFact {
  metric: string;
  concept: string;
  value: number;
  unit: string;
  periodStart?: string;
  periodEnd: string;
  form: string;
  accession: string;
  filed: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
}

export const BALANCE_CONCEPTS: Record<string, string[]> = {
  totalAssets: ["Assets"],
  longTermDebt: ["LongTermDebt"],
  longTermDebtNoncurrent: ["LongTermDebtNoncurrent"],
  longTermDebtCurrent: ["LongTermDebtCurrent"],
  ltdAndLeases: ["LongTermDebtAndCapitalLeaseObligations"],
  ltdAndLeasesCurrent: ["LongTermDebtAndCapitalLeaseObligationsCurrent"],
  debtAndLeases: ["DebtAndCapitalLeaseObligations"],
  debtCarrying: ["DebtInstrumentCarryingAmount", "DebtLongtermAndShorttermCombinedAmount"],
  convertibleNotes: ["ConvertibleLongTermNotesPayable"],
  convertibleNotesCurrent: ["ConvertibleNotesPayableCurrent"],
  otherLongTermDebt: ["OtherLongTermDebtNoncurrent"],
  debtCurrent: ["DebtCurrent"],
  shortTermBorrowings: ["ShortTermBorrowings", "OtherShortTermBorrowings"],
  commercialPaper: ["CommercialPaper"],
  commonSharesOutstanding: ["CommonStockSharesOutstanding"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "CashAndDueFromBanks", "Cash"],
  securities: ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "AvailableForSaleSecuritiesCurrent"],
  receivables: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"],
};

export const ANNUAL_CONCEPTS: Record<string, string[]> = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
  interestIncome: ["InvestmentIncomeInterest", "InterestAndDividendIncomeOperating", "InvestmentIncomeInterestAndDividend", "InterestIncomeOperating", "InterestIncomeOther", "InterestIncomeNonoperating", "InterestAndOtherIncome"],
};

const PERIODIC_FORMS = new Set(["10-K", "10-Q", "10-K/A", "10-Q/A"]);

function usd(facts: any, concept: string): XbrlFact[] {
  const units = facts?.facts?.["us-gaap"]?.[concept]?.units ?? {};
  return (units.USD ?? units.shares ?? []).filter((f: XbrlFact) => PERIODIC_FORMS.has(f.form));
}

const byLatest = (a: XbrlFact, b: XbrlFact) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed);

function toFact(metric: string, concept: string, f: XbrlFact, unit = "USD"): FinancialFact {
  return { metric, concept, value: f.val, unit, periodStart: f.start, periodEnd: f.end, form: f.form, accession: f.accn, filed: f.filed, fiscalYear: f.fy, fiscalPeriod: f.fp };
}

// The latest balance-sheet date, taken from total assets.
export function anchorDate(facts: any): string | null {
  const latest = usd(facts, "Assets").filter((f) => !f.start).sort(byLatest)[0];
  return latest?.end ?? null;
}

// For a balance-sheet metric, take the value at the anchor date from the first concept that has one.
export function balanceAt(facts: any, metric: string, anchor: string): FinancialFact | null {
  for (const concept of BALANCE_CONCEPTS[metric]) {
    const hit = usd(facts, concept).filter((f) => !f.start && f.end === anchor).sort(byLatest)[0];
    if (hit) return toFact(metric, concept, hit);
  }
  return null;
}

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

// The latest full-year value across all candidate concepts (not just the first one that exists),
// so a deprecated concept with old data never wins over a current one.
export function latestAnnual(facts: any, metric: string): FinancialFact | null {
  let best: FinancialFact | null = null;
  for (const concept of ANNUAL_CONCEPTS[metric]) {
    const hit = usd(facts, concept)
      .filter((f) => f.form.startsWith("10-K") && f.start && daysBetween(f.start, f.end) > 330 && daysBetween(f.start, f.end) < 400)
      .sort(byLatest)[0];
    if (hit && (!best || hit.end > best.periodEnd)) best = toFact(metric, concept, hit);
  }
  return best;
}

// Shares outstanding from the cover page; companies with several share classes report one fact per class.
export function sharesOutstanding(facts: any): FinancialFact | null {
  const series: XbrlFact[] = facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? [];
  if (!series.length) return null;
  const latest = [...series].sort(byLatest)[0];
  const sameFiling = series.filter((f) => f.accn === latest.accn && f.end === latest.end);
  const total = sameFiling.reduce((a, f) => a + f.val, 0);
  return { ...toFact("sharesOutstanding", "dei:EntityCommonStockSharesOutstanding", latest, "shares"), value: total };
}

export interface ExtractedFinancials {
  anchor: string | null;
  facts: FinancialFact[];
  interestBearingDebt: { value: number; components: FinancialFact[]; basis: string } | null;
  missing: string[];
}

export function extractFinancials(facts: any): ExtractedFinancials {
  const anchor = anchorDate(facts);
  const out: FinancialFact[] = [];
  const missing: string[] = [];
  if (anchor) {
    for (const metric of Object.keys(BALANCE_CONCEPTS)) {
      const f = balanceAt(facts, metric, anchor);
      if (f) out.push(f);
    }
  } else missing.push("totalAssets");
  for (const metric of Object.keys(ANNUAL_CONCEPTS)) {
    const f = latestAnnual(facts, metric);
    if (f) out.push(f);
    else missing.push(metric);
  }
  const shares = sharesOutstanding(facts);
  if (shares) out.push(shares);
  else missing.push("sharesOutstanding");

  const get = (m: string) => out.find((f) => f.metric === m);
  for (const m of ["cash", "totalAssets"]) if (anchor && !get(m)) missing.push(m);

  // Share count fallbacks when the cover page has none (or a zero): balance-sheet common shares,
  // then the latest basic weighted-average share count.
  if (!shares || shares.value <= 0) {
    const weighted = usd(facts, "WeightedAverageNumberOfSharesOutstandingBasic").sort(byLatest)[0];
    const fallback = get("commonSharesOutstanding") ?? (weighted ? toFact("sharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic", weighted, "shares") : undefined);
    const i = out.findIndex((f) => f.metric === "sharesOutstanding");
    if (i >= 0) out.splice(i, 1);
    if (fallback && fallback.value > 0) {
      out.push({ ...fallback, metric: "sharesOutstanding", unit: "shares" });
      const m = missing.indexOf("sharesOutstanding");
      if (m >= 0) missing.splice(m, 1);
    } else if (!missing.includes("sharesOutstanding")) missing.push("sharesOutstanding");
  }

  const interestBearingDebt = chooseDebt(get);
  if (!interestBearingDebt) missing.push("interestBearingDebt");

  return { anchor, facts: out, interestBearingDebt, missing };
}

// Companies tag debt inconsistently (for one filer "LongTermDebt" is a small sub-item). Build every
// complete measure the filing supports and use the largest: overstating debt can only make a screen
// stricter, never let a non-compliant company through. The chosen components are kept as evidence.
export function chooseDebt(get: (metric: string) => FinancialFact | undefined): { value: number; components: FinancialFact[]; basis: string } | null {
  const opt = (...metrics: string[]) => metrics.map(get).filter((f): f is FinancialFact => f !== undefined);
  const shortTerm = opt("shortTermBorrowings", "commercialPaper");
  const candidates: { basis: string; parts: FinancialFact[] }[] = [];
  const add = (basis: string, required: FinancialFact[] | null, extra: FinancialFact[] = []) => {
    if (required && required.length) candidates.push({ basis, parts: [...required, ...extra] });
  };
  const debtCurrent = get("debtCurrent");
  const ltdCurrent = get("longTermDebtCurrent");
  // DebtCurrent already includes short-term borrowings; otherwise add them separately.
  const currentPart = (ltdIncludesCurrent: boolean) =>
    debtCurrent
      ? ltdIncludesCurrent && ltdCurrent ? [{ ...debtCurrent, metric: "debtCurrentExcludingLtd", value: Math.max(0, debtCurrent.value - ltdCurrent.value) }] : [debtCurrent]
      : [...(ltdIncludesCurrent ? [] : opt("longTermDebtCurrent")), ...shortTerm];

  add("LongTermDebt (incl. current) + short-term debt", opt("longTermDebt"), currentPart(true));
  add("Non-current + current long-term debt + short-term debt", opt("longTermDebtNoncurrent"), currentPart(false));
  add("Long-term debt and leases + current portion + short-term debt", opt("ltdAndLeases"), [...opt("ltdAndLeasesCurrent"), ...shortTerm]);
  add("Total debt and leases", opt("debtAndLeases"));
  add("Debt instruments carrying amount", opt("debtCarrying"), shortTerm);
  add("Convertible and other notes", opt("convertibleNotes", "otherLongTermDebt"), opt("convertibleNotesCurrent"));

  if (!candidates.length) return null;
  const scored = candidates.map((c) => ({ ...c, value: c.parts.reduce((a, f) => a + f.value, 0) }));
  const best = scored.sort((a, b) => b.value - a.value)[0];
  return { value: best.value, components: best.parts, basis: best.basis };
}
