// Pulls SEC filings data and a price snapshot for the demo universe, and writes CSVs
// that are uploaded to S3 and registered as Zetaris file sources.
//   npm run ingest            # whole demo universe
//   npm run ingest -- AAPL F  # selected tickers
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/env.ts";
import { companyFacts, lookupTicker, submissions } from "../src/data/sec.ts";
import { extractFinancials } from "../src/data/financials.ts";
import { fetchPrice } from "../src/data/prices.ts";
import { ALL_TICKERS } from "../src/data/universe.ts";

const OUT = path.join(ROOT, "data", "out");
const tickers = process.argv.slice(2).length ? process.argv.slice(2).map((t) => t.toUpperCase()) : ALL_TICKERS;

const csv = (rows: Record<string, unknown>[]) => {
  const cols = Object.keys(rows[0] ?? {});
  const esc = (v: unknown) => (v === undefined || v === null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
};

const companies: Record<string, unknown>[] = [];
const facts: Record<string, unknown>[] = [];
const prices: Record<string, unknown>[] = [];
const report: Record<string, unknown>[] = [];

for (const ticker of tickers) {
  try {
    const c = await lookupTicker(ticker);
    const [raw, sub, price] = await Promise.all([companyFacts(c.cik), submissions(c.cik), fetchPrice(ticker)]);
    const fin = extractFinancials(raw);
    companies.push({ cik: c.cik, ticker, name: c.name, sic: sub.sic, sic_description: sub.sicDescription });
    for (const f of fin.facts) {
      facts.push({ cik: c.cik, ticker, metric: f.metric, concept: f.concept, value: f.value, unit: f.unit, period_start: f.periodStart, period_end: f.periodEnd, form: f.form, accession: f.accession, filed: f.filed, fiscal_year: f.fiscalYear, fiscal_period: f.fiscalPeriod });
    }
    prices.push({ ticker, price: price.price, currency: price.currency, market_time: price.marketTime, captured_at: price.capturedAt, source: "yahoo-chart" });
    const shares = fin.facts.find((f) => f.metric === "sharesOutstanding")?.value;
    const mcap = shares ? shares * price.price : undefined;
    report.push({
      ticker,
      sic: sub.sic,
      anchor: fin.anchor,
      mcapB: mcap ? (mcap / 1e9).toFixed(0) : "?",
      debtB: fin.interestBearingDebt ? (fin.interestBearingDebt.value / 1e9).toFixed(1) : "?",
      basis: fin.interestBearingDebt?.basis.slice(0, 28),
      revFY: fin.facts.find((f) => f.metric === "revenue")?.periodEnd ?? "?",
      missing: fin.missing.join(" "),
    });
  } catch (err) {
    report.push({ ticker, error: (err as Error).message });
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "companies.csv"), csv(companies));
fs.writeFileSync(path.join(OUT, "sec_facts.csv"), csv(facts));
fs.writeFileSync(path.join(OUT, "prices.csv"), csv(prices));
console.table(report);
console.log(`wrote ${companies.length} companies, ${facts.length} facts, ${prices.length} prices to data/out/`);
