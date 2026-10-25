// The curated demo set: expected-clean names, clear business-activity fails, and borderline cases.
export const DEMO_UNIVERSE = {
  likelyCompliant: ["AAPL", "MSFT", "NVDA", "GOOGL", "TSLA", "JNJ", "PG", "NKE", "ADBE", "CSCO"],
  businessActivityFail: ["JPM", "BAC", "STZ", "MO", "LVS", "DKNG", "TAP", "HRL"],
  borderline: ["COST", "WMT", "AMZN", "MAR", "T", "F", "BA"],
} as const;

export const ALL_TICKERS: string[] = Object.values(DEMO_UNIVERSE).flat();
