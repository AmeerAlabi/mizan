// Activity analyst. Reads the company's industry code and the business section of its latest 10-K,
// and estimates what share of revenue comes from activities Shariah screens exclude. Every claimed
// activity must be backed by a quote that actually appears in the filing text.
import type { RunContext } from "./context.ts";
import { callJson } from "./llm.ts";
import { businessSection } from "./tools.ts";
import { ngxBusinessText, ngxSectorFlag } from "../data/ngx.ts";

const AGENT = "activity-analyst" as const;

// SIC ranges that strongly indicate a non-compliant core business, used as a prior for the analyst.
const SIC_FLAGS: { from: number; to: number; label: string }[] = [
  { from: 6020, to: 6099, label: "conventional banking / interest-based lending" },
  { from: 6110, to: 6199, label: "conventional credit and lending" },
  { from: 6300, to: 6411, label: "conventional insurance" },
  { from: 2082, to: 2085, label: "alcoholic beverages" },
  { from: 2111, to: 2141, label: "tobacco" },
  { from: 7990, to: 7999, label: "possible gambling / adult entertainment (check)" },
  { from: 7011, to: 7011, label: "hotels: possible alcohol and gambling revenue (check)" },
  { from: 2011, to: 2013, label: "meat packing: possible pork products (check)" },
  { from: 5810, to: 5813, label: "restaurants / drinking places: possible alcohol (check)" },
];

export function sicFlag(sic: string): string | null {
  const n = Number(sic);
  return SIC_FLAGS.find((f) => n >= f.from && n <= f.to)?.label ?? null;
}

interface ActivityReply {
  non_compliant_activities: { activity: string; quote: string; estimated_revenue_share: number | null }[];
  non_compliant_revenue_share: number | null;
  confidence: number;
  rationale: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function analyseActivity(ctx: RunContext): Promise<void> {
  const { company, profile, trace, evidence, runId } = ctx;
  const ngx = ctx.ngx;
  const flag = ngx ? ngxSectorFlag(ngx.sector) : sicFlag(profile.sic);
  const sicEv = ngx
    ? evidence.add(AGENT, { ticker: company.ticker, kind: "fact", metric: "sic", content: `${company.name} sector: ${ngx.sector} (Nigerian Exchange)${flag ? `: flagged as ${flag}` : ""}`, source: `zetaris:mizan.ngx_companies#${company.ticker}`, sourceLabel: "Zetaris mizan.ngx_companies", refs: [ngx.filingUrl] }, runId)
    : evidence.add(AGENT, { ticker: company.ticker, kind: "fact", metric: "sic", content: `${company.name} SEC industry code ${profile.sic} (${profile.sicDescription})${flag ? `: flagged as ${flag}` : ""}`, source: `sec-submissions:${company.cik}`, sourceLabel: "SEC EDGAR company profile", refs: [`https://data.sec.gov/submissions/CIK${company.cik}.json`] }, runId);
  trace.emit(AGENT, "fact", sicEv.content, { refs: [sicEv.id] });

  const business = ngx ? (() => { const b = ngxBusinessText(ngx); return { text: b.text, url: b.url, accession: b.page ? `page ${b.page}` : "filing", filed: ngx.periodEnd }; })() : await businessSection(company.cik, profile, 5500);
  if (!business || !business.text) {
    trace.emit(AGENT, "issue", "No filing text found; activity cannot be assessed from the filing");
    return;
  }
  const docName = ngx ? ngx.filingTitle : "10-K business section";
  trace.emit(AGENT, "tool", `Read ${docName} (${business.text.length} chars${ngx ? `, ${business.accession}` : `, filed ${business.filed}`})`, { data: { url: business.url } });

  let reply: ActivityReply;
  try {
    reply = await askModel(business.text);
  } catch (err) {
    // Without the model, an unambiguous industry code (banks, insurers, alcohol, tobacco) is still
    // decisive evidence; ambiguous codes ("check") are left for review rather than guessed.
    if (!flag || flag.includes("(check)")) throw err;
    trace.emit(AGENT, "error", `Model unavailable (${(err as Error).message.slice(0, 60)}); falling back to the industry code`);
    const e = evidence.add(AGENT, { ticker: company.ticker, kind: "derived", metric: "nonCompliantRevenueShare", value: 0.9, content: `Core business is ${flag} (${ngx ? `sector: ${ngx.sector}` : `SEC industry code ${profile.sic}`}); estimated non-compliant revenue share 90% from the industry classification alone`, source: `agent:activity-analyst:sic:${sicEv.id}`, sourceLabel: "Industry-code fallback (model unavailable)", refs: [sicEv.id, business.url], confidence: 0.6 }, runId);
    trace.emit(AGENT, "result", e.content, { refs: [e.id, sicEv.id] });
    return;
  }

  async function askModel(filingText: string) {
    return callJson<ActivityReply>(
    `You are the Activity Analyst in Mizan, a Shariah stock-screening system. Screens exclude companies whose revenue from these activities is 5% or more: conventional interest-based banking, lending or insurance; alcohol; pork; gambling; tobacco; adult entertainment; weapons designed for offense are excluded by some standards (note but do not count). Retail or hospitality businesses that SELL some alcohol or tobacco count only that portion.
Work only from the filing text you are given. For each non-compliant activity, give a short quote copied EXACTLY from the text and your estimate of its share of total revenue (0 to 1), or null if the text does not let you estimate it. If the core business is non-compliant, the total share is high (e.g. 0.9). If nothing non-compliant is described, return an empty list and 0.
JSON shape: {"non_compliant_activities":[{"activity":"...","quote":"...","estimated_revenue_share":0.0}],"non_compliant_revenue_share":0.0,"confidence":0.0,"rationale":"..."}`,
    `Company: ${company.name} (${company.ticker})\n${ngx ? `Sector (Nigerian Exchange): ${ngx.sector}` : `SEC industry code: ${profile.sic} ${profile.sicDescription}`}${flag ? ` [prior flag: ${flag}]` : ""}\n\n${ngx ? `${ngx.filingTitle}, principal activities` : "10-K business section"} (excerpt):\n${filingText}`,
    { agent: AGENT, trace, tier: "deep", purpose: "classify business activities from 10-K" },
    (v) => (Array.isArray(v.non_compliant_activities) ? null : "non_compliant_activities must be an array"),
  );
  }

  // Keep only activities whose quote really appears in the filing.
  const text = norm(business.text);
  const quoteIds: string[] = [];
  for (const a of reply.non_compliant_activities) {
    const q = norm(a.quote ?? "");
    const found = q.length >= 12 && text.includes(q.slice(0, Math.min(q.length, 80)));
    if (!found) {
      trace.emit(AGENT, "issue", `Dropped "${a.activity}": its quote was not found in the 10-K`);
      continue;
    }
    const e = evidence.add(AGENT, { ticker: company.ticker, kind: "quote", metric: "activity", content: `${a.activity}: "${a.quote}"${a.estimated_revenue_share !== null ? ` (est. ${(a.estimated_revenue_share * 100).toFixed(1)}% of revenue)` : ""}`, source: `${business.url}#${business.accession}`, sourceLabel: ngx ? `${ngx.filingTitle}, ${business.accession}` : `10-K filed ${business.filed}, Item 1 Business`, refs: [business.url] }, runId);
    quoteIds.push(e.id);
    trace.emit(AGENT, "fact", e.content, { refs: [e.id] });
  }

  let share = quoteIds.length === 0 && reply.non_compliant_activities.length > 0 ? null : quoteIds.length === 0 ? 0 : reply.non_compliant_revenue_share;
  // Industries where non-compliant revenue is usually present but rarely broken out (hotels and
  // restaurants serving alcohol, meat packers handling pork): a 0% read from a short excerpt is not
  // proof, so the share is left unquantified and the case goes to a scholar.
  if (flag?.includes("(check)") && !share) {
    share = null;
    reply.rationale = `${reply.rationale} The industry code (${profile.sicDescription}) suggests possible ${flag.replace(" (check)", "")}, which the filing excerpt does not quantify, so this needs review rather than a pass.`;
  }
  const e = evidence.add(
    AGENT,
    {
      ticker: company.ticker,
      kind: "derived",
      metric: "nonCompliantRevenueShare",
      value: share ?? undefined,
      content: `Estimated non-compliant revenue share: ${share === null ? "could not be quantified" : `${(share * 100).toFixed(1)}%`} (confidence ${reply.confidence}). ${reply.rationale}`,
      source: `agent:activity-analyst${quoteIds.length ? `:${quoteIds.join("+")}` : ""}`,
      sourceLabel: ngx ? `Activity analysis of ${ngx.filingTitle}, ${business.accession}` : `Activity analysis of 10-K filed ${business.filed}`,
      refs: [business.url, sicEv.id, ...quoteIds],
      confidence: Math.max(0.1, Math.min(1, reply.confidence ?? 0.5)),
      extraTags: share === null ? ["unquantified"] : [],
    },
    runId,
  );
  trace.emit(AGENT, "result", e.content, { refs: [e.id, ...quoteIds] });
}
