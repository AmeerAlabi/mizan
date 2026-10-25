// Loads the verified Nigerian Exchange figures (data/ngx/*.json) into Zetaris as governed views in
// the "mizan" container, next to the SEC sources, so agents query both markets with the same SQL.
//   npm run ngx:load            # run (idempotent: CREATE OR REPLACE)
//   npm run ngx:load -- --dry   # print the statements
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/env.ts";
import { runSql } from "../src/data/zetaris.ts";

const dry = process.argv.includes("--dry");
const filings = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "ngx", "filings.json"), "utf8"));
const prices = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "ngx", "prices.json"), "utf8"));

const q = (s: unknown) => (s === undefined || s === null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const n = (v: number) => (Number.isFinite(v) ? `CAST(${v} AS DOUBLE)` : "NULL");

const companyRows = filings.companies.map((c: any) =>
  `(${q(c.ticker)}, ${q(c.name)}, ${q(c.sector)}, ${q(c.periodEnd)}, ${q(c.filing.title)}, ${q(c.filing.url)}, ${q(c.activity?.quote)}, ${c.activity?.page ?? "NULL"})`,
);
const factRows = filings.companies.flatMap((c: any) =>
  c.facts.map((f: any) => {
    const unit = f.unitOverride ?? c.unit;
    const value = f.value * unit;
    const ccy = f.metric === "sharesOutstanding" ? "shares" : c.currency;
    return `(${q(c.ticker)}, ${q(f.metric)}, ${n(value)}, ${q(ccy)}, ${q(c.periodEnd)}, ${f.page}, ${q(f.line)}, ${q(c.filing.url)}, ${q(f.check)})`;
  }),
);
const priceRows = Object.entries(prices.prices).map(([t, p]) => `(${q(t)}, ${n(p as number)}, 'NGN', ${q(prices.date)}, ${q(`${prices.source}${t.toLowerCase()}.html`)})`);

const statements = [
  `CREATE OR REPLACE SCHEMASTORE VIEW ngx_companies WITH CONTAINER mizan AS SELECT * FROM VALUES ${companyRows.join(", ")} AS t(ticker, name, sector, period_end, filing_title, filing_url, activity_quote, activity_page)`,
  `CREATE OR REPLACE SCHEMASTORE VIEW ngx_facts WITH CONTAINER mizan AS SELECT * FROM VALUES ${factRows.join(", ")} AS t(ticker, metric, value, unit, period_end, page, line, filing_url, verified)`,
  `CREATE OR REPLACE SCHEMASTORE VIEW ngx_prices WITH CONTAINER mizan AS SELECT * FROM VALUES ${priceRows.join(", ")} AS t(ticker, price, currency, price_date, source)`,
];

for (const sql of statements) {
  if (dry) {
    console.log(sql.slice(0, 400) + (sql.length > 400 ? " …" : "") + ";\n");
    continue;
  }
  const r = await runSql(sql, 1);
  console.log(`OK  ${sql.slice(0, 70)}…  (${r.ms} ms)`);
}
if (!dry) {
  const check = await runSql("SELECT f.ticker, count(*) AS facts, max(p.price) AS price FROM mizan.ngx_facts f LEFT JOIN mizan.ngx_prices p ON f.ticker = p.ticker GROUP BY f.ticker ORDER BY f.ticker", 20);
  console.table(check.rows);
}
