// Tools the agents can call. Zetaris is the primary, governed source; the SEC XBRL search is the
// fallback for concepts Zetaris has not registered. Agents may only record numbers they actually saw.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../env.ts";
import { runSql } from "../data/zetaris.ts";
import { companyFacts, companyFactsUrl, filingUrl, type Submissions } from "../data/sec.ts";
import type { ToolSpec } from "../llm/meterless.ts";

const READ_ONLY = /^\s*(select|with|show|describe|desc)\b/i;

export const ZETARIS_TABLES = `Zetaris tables (container "mizan"), one row per SEC filer, columns: cik (10-digit string), entity_name, concept, frame, period_end, value_usd, accession.
- mizan.assets_q (Assets, quarter-end CY2026Q2I)
- mizan.ltd_q (LongTermDebt, incl. current portion), mizan.ltd_noncurrent_q (LongTermDebtNoncurrent), mizan.ltd_current_q (LongTermDebtCurrent)
- mizan.debt_current_q (DebtCurrent), mizan.st_borrowings_q (ShortTermBorrowings)
- mizan.ltd_leases_q (LongTermDebtAndCapitalLeaseObligations), mizan.ltd_leases_current_q (its current portion), mizan.debt_leases_q (DebtAndCapitalLeaseObligations), mizan.debt_carrying_q (DebtInstrumentCarryingAmount)
- mizan.cash_q (CashAndCashEquivalentsAtCarryingValue), mizan.securities_q (MarketableSecuritiesCurrent), mizan.receivables_q (AccountsReceivableNetCurrent)
- mizan.revenue_fy (RevenueFromContractWithCustomerExcludingAssessedTax, CY2025), mizan.revenues_fy (Revenues, CY2025), mizan.interest_income_fy (InvestmentIncomeInterest, CY2025)
Lightning SQL (Spark dialect). One statement per call. Read-only.`;

export const TABLE_NAMES = ["assets_q", "ltd_q", "ltd_noncurrent_q", "ltd_current_q", "debt_current_q", "st_borrowings_q", "ltd_leases_q", "ltd_leases_current_q", "debt_leases_q", "debt_carrying_q", "cash_q", "securities_q", "receivables_q", "revenue_fy", "revenues_fy", "interest_income_fy"];

export async function zetarisQuery(sql: string, limit = 30) {
  if (!READ_ONLY.test(sql)) throw new Error("Only read-only statements (SELECT, SHOW, DESCRIBE) are allowed.");
  // Small models sometimes misspell the container name; fix the obvious variants.
  sql = sql.replace(/\bmiz[a-z]n\./gi, "mizan.");
  try {
    return await runSql(sql, limit);
  } catch (err) {
    // Give the agent something actionable instead of a bare engine error.
    throw new Error(`${(err as Error).message.slice(0, 200)} | Valid tables: ${TABLE_NAMES.map((t) => `mizan.${t}`).join(", ")}`);
  }
}

export interface XbrlHit {
  concept: string;
  unit: string;
  latestValue: number;
  periodStart?: string;
  periodEnd: string;
  form: string;
  accession: string;
  stale: boolean; // latest value is more than 21 months old: the company stopped reporting it
}

// Search a company's full XBRL filing data for concepts matching a pattern; return each one's latest value.
export async function xbrlSearch(cik: string, pattern: string, limit = 15): Promise<XbrlHit[]> {
  const facts = await companyFacts(cik);
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: XbrlHit[] = [];
  for (const ns of ["us-gaap", "dei"]) {
    for (const [concept, body] of Object.entries<any>(facts.facts?.[ns] ?? {})) {
      if (!re.test(concept)) continue;
      for (const [unit, series] of Object.entries<any[]>(body.units ?? {})) {
        const latest = series.filter((f) => /^10-[KQ]/.test(f.form)).sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0];
        if (latest) hits.push({ concept: `${ns}:${concept}`, unit, latestValue: latest.val, periodStart: latest.start, periodEnd: latest.end, form: latest.form, accession: latest.accn, stale: Date.now() - Date.parse(latest.end) > 21 * 30.44 * 86_400_000 });
      }
    }
  }
  return hits.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, limit);
}

export { companyFactsUrl };

// The business section of the latest 10-K, as plain text, for the activity analyst.
export async function businessSection(cik: string, profile: Submissions, maxChars = 9000): Promise<{ text: string; url: string; accession: string; filed: string } | null> {
  const tenK = profile.recentFilings.find((f) => f.form === "10-K");
  if (!tenK) return null;
  const url = filingUrl(cik, tenK.accessionNumber, tenK.primaryDocument);
  const cache = path.join(ROOT, "data", "cache", "sec", "filings", `${tenK.accessionNumber}.txt`);
  let text: string;
  if (fs.existsSync(cache)) text = fs.readFileSync(cache, "utf8");
  else {
    const ua = (process.env.SEC_USER_AGENT ?? "mizan-hackathon research-agent").replace(/"/g, "");
    const res = await fetch(url, { headers: { "User-Agent": ua.includes(" ") ? ua : `mizan ${ua}` } });
    if (!res.ok) throw new Error(`SEC ${res.status} fetching 10-K`);
    text = htmlToText(await res.text());
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, text);
  }
  // The first "Item 1. Business" is usually the table of contents; take the one followed by real prose.
  const starts = [...text.matchAll(/item\s*1\.?\s*(?:—|-|:)?\s*business\b/gi)].map((m) => m.index!);
  const start = starts.find((i) => !/item\s*1a/i.test(text.slice(i, i + 400))) ?? starts[1] ?? starts[0] ?? 0;
  const end = text.slice(start + 100).search(/item\s*1a\.?\s*(?:—|-|:)?\s*risk factors/i);
  const section = text.slice(start, end > 0 ? start + 100 + end : start + maxChars * 3);
  return { text: section.slice(0, maxChars), url, accession: tenK.accessionNumber, filed: tenK.filingDate };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#\d+;|&[a-z]+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export const RESEARCH_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "run_sql",
      description: "Run ONE read-only Lightning SQL statement on Zetaris and return up to 30 rows as JSON.",
      parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
    },
  },
  {
    type: "function",
    function: {
      name: "xbrl_search",
      description: "Search this company's full SEC XBRL data for concept names matching a regex (e.g. 'Debt|Borrowing|NotesPayable'); returns each concept's latest value, period and accession.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  },
  {
    type: "function",
    function: {
      name: "record_fact",
      description: "Record a value you found for a metric. The value must appear exactly in an earlier tool result. Use the sum of components only if you name every component in 'components'.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string" },
          value: { type: "number" },
          period_end: { type: "string", description: "YYYY-MM-DD" },
          source: { type: "string", enum: ["zetaris", "sec-xbrl"] },
          reference: { type: "string", description: "Zetaris table or XBRL concept name" },
          accession: { type: "string" },
          components: { type: "array", items: { type: "object", properties: { reference: { type: "string" }, value: { type: "number" } } } },
          note: { type: "string", description: "Why this value answers the metric" },
        },
        required: ["metric", "value", "period_end", "source", "reference", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "give_up",
      description: "Stop researching a metric because no reliable value exists; explain why.",
      parameters: { type: "object", properties: { metric: { type: "string" }, reason: { type: "string" } }, required: ["metric", "reason"] },
    },
  },
];
