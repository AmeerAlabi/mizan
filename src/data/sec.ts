// SEC EDGAR client: tickers, company facts (XBRL) and submissions (SIC, filings), cached on disk.
import fs from "node:fs";
import path from "node:path";
import { ROOT, env } from "../env.ts";

const CACHE = path.join(ROOT, "data", "cache", "sec");
const DAY = 86_400_000;

function userAgent(): string {
  return env("SEC_USER_AGENT", "mizan-hackathon research-agent");
}

let lastCall = 0;
async function getJson(url: string, cacheFile: string, maxAgeMs: number): Promise<any> {
  const file = path.join(CACHE, cacheFile);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  // SEC asks for at most 10 requests per second.
  const wait = lastCall + 120 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": userAgent(), Accept: "application/json" } });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  const body = await res.json();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
  return body;
}

export interface Company {
  cik: string; // zero-padded, 10 digits
  ticker: string;
  name: string;
}

export async function lookupTicker(ticker: string): Promise<Company> {
  const all = await getJson("https://www.sec.gov/files/company_tickers.json", "company_tickers.json", 7 * DAY);
  const row = Object.values<any>(all).find((t) => t.ticker === ticker.toUpperCase());
  if (!row) throw new Error(`Ticker ${ticker} not found in SEC list`);
  return { cik: String(row.cik_str).padStart(10, "0"), ticker: row.ticker, name: row.title };
}

export function companyFactsUrl(cik: string) {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
}

export async function companyFacts(cik: string): Promise<any> {
  return getJson(companyFactsUrl(cik), `facts/${cik}.json`, DAY);
}

export interface Submissions {
  sic: string;
  sicDescription: string;
  name: string;
  recentFilings: { form: string; accessionNumber: string; filingDate: string; primaryDocument: string; reportDate: string }[];
}

export async function submissions(cik: string): Promise<Submissions> {
  const s = await getJson(`https://data.sec.gov/submissions/CIK${cik}.json`, `submissions/${cik}.json`, DAY);
  const r = s.filings?.recent ?? {};
  const recentFilings = (r.form ?? []).map((form: string, i: number) => ({
    form,
    accessionNumber: r.accessionNumber[i],
    filingDate: r.filingDate[i],
    primaryDocument: r.primaryDocument[i],
    reportDate: r.reportDate[i],
  }));
  return { sic: s.sic, sicDescription: s.sicDescription, name: s.name, recentFilings };
}

export function filingUrl(cik: string, accession: string, primaryDocument?: string) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;
  return primaryDocument ? `${base}/${primaryDocument}` : `${base}/${accession}-index.htm`;
}
