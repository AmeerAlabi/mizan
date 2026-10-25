import { describe, expect, it } from "vitest";
import { classify, purificationRate, screen, type ScreenInputs } from "../src/calc/screen.ts";
import { AAOIFI, MSCI } from "../src/calc/standards.ts";

const s = (value: number, id = "ev") => ({ value, evidenceIds: [id] });

const clean: ScreenInputs = {
  marketCap: s(1000, "mcap"),
  totalAssets: s(500, "assets"),
  totalRevenue: s(400, "rev"),
  interestBearingDebt: s(50, "debt"),
  cash: s(40, "cash"),
  interestBearingSecurities: s(10, "sec"),
  receivables: s(20, "ar"),
  interestIncome: s(4, "int"),
  nonCompliantRevenueShare: { value: 0, evidenceIds: ["act"], rationale: "none" },
};

describe("classify", () => {
  it("fails at the limit, not just above it", () => {
    expect(classify(0.3, 0.3)).toBe("FAIL");
  });
  it("is borderline within 10% of the limit", () => {
    expect(classify(0.28, 0.3)).toBe("BORDERLINE");
    expect(classify(0.26, 0.3)).toBe("PASS");
  });
});

describe("AAOIFI", () => {
  it("passes a clean company and traces every ratio to its evidence", () => {
    const r = screen(AAOIFI, clean);
    expect(r.verdict).toBe("COMPLIANT");
    const debt = r.ratios.find((t) => t.id === "debt")!;
    expect(debt.ratio).toBeCloseTo(0.05);
    expect(debt.evidenceIds).toEqual(["debt", "mcap"]);
  });

  it("fails on debt above 30% of market cap", () => {
    const r = screen(AAOIFI, { ...clean, interestBearingDebt: s(350) });
    expect(r.verdict).toBe("NON_COMPLIANT");
    expect(r.reasons[0]).toMatch(/debt/i);
  });

  it("fails on non-compliant business activity regardless of ratios", () => {
    const r = screen(AAOIFI, { ...clean, nonCompliantRevenueShare: { value: 0.9, evidenceIds: ["10k"], rationale: "bank" } });
    expect(r.verdict).toBe("NON_COMPLIANT");
    expect(r.business.status).toBe("FAIL");
  });

  it("needs review when business activity could not be quantified", () => {
    const r = screen(AAOIFI, { ...clean, nonCompliantRevenueShare: { value: null, evidenceIds: [], rationale: "hotel bars" } });
    expect(r.verdict).toBe("NEEDS_REVIEW");
  });

  it("needs review, not a pass, when a denominator is missing", () => {
    const { marketCap: _omit, ...noCap } = clean;
    const r = screen(AAOIFI, noCap);
    expect(r.verdict).toBe("NEEDS_REVIEW");
    expect(r.ratios.find((t) => t.id === "debt")!.missing).toContain("marketCap");
  });

  it("treats securities as optional when cash exists but reports the gap", () => {
    const { interestBearingSecurities: _omit, ...noSec } = clean;
    const cash = screen(AAOIFI, noSec).ratios.find((t) => t.id === "cash")!;
    expect(cash.ratio).toBeCloseTo(0.04);
    expect(cash.missing).toEqual(["interestBearingSecurities"]);
  });
});

describe("standards disagree", () => {
  it("AAOIFI (market cap) passes while MSCI (total assets) fails for a richly valued, indebted firm", () => {
    const inputs = { ...clean, marketCap: s(2000), totalAssets: s(400), interestBearingDebt: s(200) };
    expect(screen(AAOIFI, inputs).verdict).toBe("COMPLIANT");
    expect(screen(MSCI, inputs).verdict).toBe("NON_COMPLIANT");
  });
});

describe("purification", () => {
  it("adds interest income share and non-compliant revenue share", () => {
    expect(purificationRate({ ...clean, nonCompliantRevenueShare: { value: 0.02, evidenceIds: [], rationale: "" } })).toBeCloseTo(0.03);
  });
});
