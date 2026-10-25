// Screening standards as data. Adding a standard is a data change, not a code change.
// Thresholds come from published methodology summaries; verify against the
// primary AAOIFI Shariah Standard No. 21 text before treating them as final.

export type Metric =
  | "interestBearingDebt"
  | "cashAndInterestBearingSecurities"
  | "cashSecuritiesAndReceivables"
  | "nonCompliantIncome";

export type Denominator = "marketCap" | "totalAssets" | "totalRevenue";

export interface RatioRule {
  id: string;
  label: string;
  metric: Metric;
  denominator: Denominator;
  limit: number; // exclusive upper bound, as a fraction
}

export interface Standard {
  id: string;
  name: string;
  businessActivityLimit: number; // max share of revenue from non-compliant activities
  ratios: RatioRule[];
  source: string;
}

export const AAOIFI: Standard = {
  id: "aaoifi",
  name: "AAOIFI Shariah Standard No. 21",
  businessActivityLimit: 0.05,
  ratios: [
    { id: "debt", label: "Interest-bearing debt / market cap", metric: "interestBearingDebt", denominator: "marketCap", limit: 0.3 },
    { id: "cash", label: "Interest-bearing cash and securities / market cap", metric: "cashAndInterestBearingSecurities", denominator: "marketCap", limit: 0.3 },
    { id: "income", label: "Non-compliant income / total revenue", metric: "nonCompliantIncome", denominator: "totalRevenue", limit: 0.05 },
  ],
  source: "AAOIFI SS-21 as summarised in screening methodologies (to verify)",
};

export const MSCI: Standard = {
  id: "msci",
  name: "MSCI Islamic Index methodology",
  businessActivityLimit: 0.05,
  ratios: [
    { id: "debt", label: "Total debt / total assets", metric: "interestBearingDebt", denominator: "totalAssets", limit: 1 / 3 },
    { id: "cash", label: "Cash and interest-bearing securities / total assets", metric: "cashAndInterestBearingSecurities", denominator: "totalAssets", limit: 1 / 3 },
    { id: "receivables", label: "Receivables, cash and securities / total assets", metric: "cashSecuritiesAndReceivables", denominator: "totalAssets", limit: 1 / 3 },
    { id: "income", label: "Non-compliant income / total revenue", metric: "nonCompliantIncome", denominator: "totalRevenue", limit: 0.05 },
  ],
  source: "MSCI Islamic Index Series methodology (to verify)",
};

export const STANDARDS: Record<string, Standard> = { aaoifi: AAOIFI, msci: MSCI };

// A result within this fraction of its limit is reported as borderline.
export const BORDERLINE_MARGIN = 0.1;
