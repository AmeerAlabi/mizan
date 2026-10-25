// Nigerian Exchange (NGX) companies. Their audited figures live in Zetaris (mizan.ngx_* views, loaded
// by scripts/ngx-load.ts from data/ngx/filings.json); the filing PDFs' text is used for business
// activity and for the researcher's filing search.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../env.ts";
import { runSql } from "./zetaris.ts";
import type { Company, Submissions } from "./sec.ts";

export interface NgxCompany {
  ticker: string;
  name: string;
  sector: string;
  periodEnd: string;
  filingTitle: string;
  filingUrl: string;
  activityQuote: string | null;
  activityPage: number | null;
}

const FILINGS = path.join(ROOT, "data", "ngx", "filings.json");
const CACHE = path.join(ROOT, "data", "cache", "ngx");

export function isNgxTicker(ticker: string): boolean {
  if (!fs.existsSync(FILINGS)) return false;
  return JSON.parse(fs.readFileSync(FILINGS, "utf8")).companies.some((c: { ticker: string }) => c.ticker === ticker.toUpperCase());
}

// The company profile comes from Zetaris, the same governed layer the figures come from.
export async function lookupNgx(ticker: string): Promise<NgxCompany | null> {
  const r = await runSql(`SELECT * FROM mizan.ngx_companies WHERE ticker = '${ticker.toUpperCase().replace(/[^A-Z]/g, "")}'`, 1);
  const row = r.rows[0];
  if (!row) return null;
  return {
    ticker: String(row.ticker),
    name: String(row.name),
    sector: String(row.sector),
    periodEnd: String(row.period_end),
    filingTitle: String(row.filing_title),
    filingUrl: String(row.filing_url),
    activityQuote: row.activity_quote ? String(row.activity_quote) : null,
    activityPage: row.activity_page ? Number(row.activity_page) : null,
  };
}

// Adapters so the rest of the pipeline can treat NGX and SEC companies alike.
export function asCompany(c: NgxCompany): Company {
  return { cik: `NGX:${c.ticker}`, ticker: c.ticker, name: c.name };
}

export function asProfile(c: NgxCompany): Submissions {
  return { sic: "", sicDescription: c.sector, name: c.name, recentFilings: [] };
}

function filingText(ticker: string): string[] | null {
  const meta = JSON.parse(fs.readFileSync(FILINGS, "utf8")).companies.find((c: { ticker: string }) => c.ticker === ticker);
  if (!meta) return null;
  // Extracted filing text ships with the repo (data/ngx/text); a local re-extraction cache wins if present.
  const name = meta.filing.file.replace(/\.pdf$/i, ".txt");
  const txt = [path.join(CACHE, name), path.join(ROOT, "data", "ngx", "text", name)].find((p) => fs.existsSync(p));
  return txt ? fs.readFileSync(txt, "latin1").split("\f") : null;
}

// Business description for the activity analyst: the filing page that states the principal activities.
export function ngxBusinessText(c: NgxCompany, maxChars = 5500): { text: string; url: string; page: number | null } {
  const pages = filingText(c.ticker);
  const page = c.activityPage;
  const body = pages && page ? pages[page - 1] ?? "" : "";
  const text = (body.replace(/[ \t]+/g, " ").trim() || c.activityQuote || "").slice(0, maxChars);
  return { text, url: page ? `${c.filingUrl}#page=${page}` : c.filingUrl, page };
}

// Researcher tool: lines in the filing that match a pattern, with their PDF page numbers.
export function ngxFilingSearch(ticker: string, pattern: string, limit = 12): { page: number; line: string }[] {
  const pages = filingText(ticker);
  if (!pages) return [];
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: { page: number; line: string }[] = [];
  pages.forEach((p, i) => {
    for (const line of p.split("\n")) if (re.test(line) && /\d/.test(line)) hits.push({ page: i + 1, line: line.replace(/\s{2,}/g, "  ").trim().slice(0, 200) });
  });
  return hits.slice(0, limit);
}

// The unit the filing prints amounts in (1000 for NGN thousands, 1e6 for NGN millions).
export function ngxUnit(ticker: string): number {
  const meta = JSON.parse(fs.readFileSync(FILINGS, "utf8")).companies.find((c: { ticker: string }) => c.ticker === ticker);
  return meta?.unit ?? 1;
}

// Sector keywords that flag a non-compliant core business (the NGX equivalent of the SIC prior).
export function ngxSectorFlag(sector: string): string | null {
  if (/bank|lending|insurance/i.test(sector)) return "conventional banking / interest-based lending";
  if (/brew|beer|spirit|distill|wine/i.test(sector)) return "alcoholic beverages";
  if (/tobacco|cigarette/i.test(sector)) return "tobacco";
  if (/hotel|hospitality/i.test(sector)) return "hotels: possible alcohol revenue (check)";
  return null;
}
