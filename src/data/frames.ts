// SEC XBRL frames registered in Zetaris. Instant frames (suffix I) are balance-sheet values at a
// quarter end; duration frames (CYyyyy) are calendar-year income values.
export interface Frame {
  table: string;
  concept: string;
  period: string;
}

export const BALANCE_PERIOD = "CY2026Q2I";
export const ANNUAL_PERIOD = "CY2025";

export const FRAMES: Frame[] = [
  { table: "assets_q", concept: "Assets", period: BALANCE_PERIOD },
  { table: "ltd_q", concept: "LongTermDebt", period: BALANCE_PERIOD },
  { table: "ltd_noncurrent_q", concept: "LongTermDebtNoncurrent", period: BALANCE_PERIOD },
  { table: "ltd_current_q", concept: "LongTermDebtCurrent", period: BALANCE_PERIOD },
  { table: "debt_current_q", concept: "DebtCurrent", period: BALANCE_PERIOD },
  { table: "st_borrowings_q", concept: "ShortTermBorrowings", period: BALANCE_PERIOD },
  { table: "ltd_leases_q", concept: "LongTermDebtAndCapitalLeaseObligations", period: BALANCE_PERIOD },
  { table: "ltd_leases_current_q", concept: "LongTermDebtAndCapitalLeaseObligationsCurrent", period: BALANCE_PERIOD },
  { table: "debt_leases_q", concept: "DebtAndCapitalLeaseObligations", period: BALANCE_PERIOD },
  { table: "debt_carrying_q", concept: "DebtInstrumentCarryingAmount", period: BALANCE_PERIOD },
  { table: "cash_q", concept: "CashAndCashEquivalentsAtCarryingValue", period: BALANCE_PERIOD },
  { table: "securities_q", concept: "MarketableSecuritiesCurrent", period: BALANCE_PERIOD },
  { table: "receivables_q", concept: "AccountsReceivableNetCurrent", period: BALANCE_PERIOD },
  { table: "revenue_fy", concept: "RevenueFromContractWithCustomerExcludingAssessedTax", period: ANNUAL_PERIOD },
  { table: "revenues_fy", concept: "Revenues", period: ANNUAL_PERIOD },
  { table: "interest_income_fy", concept: "InvestmentIncomeInterest", period: ANNUAL_PERIOD },
];
