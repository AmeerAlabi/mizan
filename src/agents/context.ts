// Shared state for one screening run: the company, the evidence store and the trace.
import type { Company, Submissions } from "../data/sec.ts";
import type { EvidenceStore } from "../memory/evidence.ts";
import type { Trace } from "./trace.ts";
import type { NgxCompany } from "../data/ngx.ts";

// Metrics the calculator needs, and what they mean (shown to agents).
export const METRICS: Record<string, string> = {
  totalAssets: "Total assets at the latest balance-sheet date",
  interestBearingDebt: "All interest-bearing debt: long-term (incl. current portion) plus short-term borrowings and commercial paper",
  cash: "Cash and cash equivalents",
  interestBearingSecurities: "Short-term interest-bearing investments / marketable securities",
  receivables: "Accounts receivable, net",
  totalRevenue: "Total revenue for the latest full fiscal year",
  interestIncome: "Interest income for the latest full fiscal year",
  sharesOutstanding: "Common shares outstanding",
  marketCap: "Market capitalisation = price x shares outstanding",
};

export const REQUIRED_METRICS = ["totalAssets", "interestBearingDebt", "cash", "totalRevenue", "interestIncome", "marketCap"];

export interface RunContext {
  runId: string;
  company: Company;
  profile: Submissions;
  evidence: EvidenceStore;
  trace: Trace;
  today: string;
  market: "US" | "NGX";
  currency: "USD" | "NGN";
  ngx?: NgxCompany;
}
