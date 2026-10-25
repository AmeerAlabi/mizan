// Researcher agent. Round 1 pulls every screening figure for the company from Zetaris in one
// cross-table query. Later rounds are a Nemotron tool loop that chases the specific gaps the
// evaluator raised, querying Zetaris first and the company's full SEC XBRL data second.
import { chooseDebt, extractFinancials, type FinancialFact } from "../data/financials.ts";
import { companyFacts, companyFactsUrl } from "../data/sec.ts";
import { fetchPrice } from "../data/prices.ts";
import { FRAMES } from "../data/frames.ts";
import type { Evidence } from "../memory/evidence.ts";
import type { ChatMessage } from "../llm/meterless.ts";
import { METRICS, type RunContext } from "./context.ts";
import { call } from "./llm.ts";
import { RESEARCH_TOOLS, ZETARIS_TABLES, xbrlSearch, zetarisQuery } from "./tools.ts";
import { ngxFilingSearch, ngxUnit } from "../data/ngx.ts";
import type { ToolSpec } from "../llm/meterless.ts";

// NGX research tools: Zetaris SQL plus a search over the company's annual report text.
const NGX_TOOLS: ToolSpec[] = [
  ...RESEARCH_TOOLS.filter((t) => t.function.name !== "xbrl_search"),
  {
    type: "function",
    function: {
      name: "filing_search",
      description: "Search the company's annual report text for lines matching a regex (e.g. 'Borrowings|Overdraft'); returns matching lines with their PDF page numbers.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  },
];
import type { Issue } from "./evaluator.ts";

const AGENT = "researcher" as const;

// Which screening metric each Zetaris table feeds.
const TABLE_METRIC: Record<string, string> = {
  assets_q: "totalAssets",
  ltd_q: "longTermDebt",
  ltd_noncurrent_q: "longTermDebtNoncurrent",
  ltd_current_q: "longTermDebtCurrent",
  debt_current_q: "debtCurrent",
  st_borrowings_q: "shortTermBorrowings",
  ltd_leases_q: "ltdAndLeases",
  ltd_leases_current_q: "ltdAndLeasesCurrent",
  debt_leases_q: "debtAndLeases",
  debt_carrying_q: "debtCarrying",
  cash_q: "cash",
  securities_q: "interestBearingSecurities",
  receivables_q: "receivables",
  revenue_fy: "totalRevenue",
  revenues_fy: "totalRevenue",
  interest_income_fy: "interestIncome",
};

const usd = (v: number) => `$${(v / 1e9).toFixed(2)}B`;

export async function gatherFromZetaris(ctx: RunContext): Promise<void> {
  if (ctx.market === "NGX") return gatherNgx(ctx);
  const { company, trace, evidence, runId } = ctx;
  const sql = FRAMES.map((f) => `SELECT '${f.table}' AS src, concept, period_end, value_usd, accession FROM mizan.${f.table} WHERE cik = '${company.cik}'`).join(" UNION ALL ");
  trace.emit(AGENT, "tool", `Zetaris: one query across ${FRAMES.length} SEC sources for ${company.ticker}`, { data: { sql } });
  const r = await zetarisQuery(sql, 100);
  trace.emit(AGENT, "tool", `Zetaris returned ${r.rows.length} rows in ${r.ms} ms`);

  const byMetric = new Map<string, FinancialFact & { table: string }>();
  for (const row of r.rows) {
    const table = String(row.src);
    const metric = TABLE_METRIC[table];
    const value = Number(row.value_usd);
    if (!metric || !Number.isFinite(value)) continue;
    const fact = { metric, table, concept: String(row.concept), value, unit: "USD", periodEnd: String(row.period_end), form: "", accession: String(row.accession), filed: "" };
    const prev = byMetric.get(metric);
    // Two revenue tables can both answer totalRevenue; keep the larger (total revenue, not a component).
    if (!prev || (metric === "totalRevenue" && value > prev.value)) byMetric.set(metric, fact);
  }

  const stored = new Map<string, Evidence>();
  for (const [metric, f] of byMetric) {
    const e = evidence.add(
      AGENT,
      {
        ticker: company.ticker,
        kind: "fact",
        metric,
        value: f.value,
        periodEnd: f.periodEnd,
        content: `${company.name} ${metric} (${f.concept}) = ${usd(f.value)} for period ending ${f.periodEnd}`,
        source: `zetaris:mizan.${f.table}#${f.accession}`,
        sourceLabel: `Zetaris mizan.${f.table} (SEC XBRL frame), accession ${f.accession}`,
        refs: [companyFactsUrl(company.cik)],
      },
      runId,
    );
    stored.set(metric, e);
    trace.emit(AGENT, "fact", e.content, { refs: [e.id] });
  }

  recordDebt(ctx, byMetric, stored);
}

// Interest-bearing debt is built from components; reuse the same conservative rule as the ingest.
function recordDebt(ctx: RunContext, facts: Map<string, FinancialFact>, stored: Map<string, Evidence>) {
  const debt = chooseDebt((m) => facts.get(m));
  if (!debt) {
    ctx.trace.emit(AGENT, "fact", "No interest-bearing debt components found in Zetaris");
    return;
  }
  const ids = debt.components.map((c) => stored.get(c.metric)?.id).filter((x): x is string => !!x);
  const e = ctx.evidence.add(
    AGENT,
    {
      ticker: ctx.company.ticker,
      kind: "derived",
      metric: "interestBearingDebt",
      value: debt.value,
      periodEnd: debt.components[0].periodEnd,
      content: `${ctx.company.name} interest-bearing debt = ${usd(debt.value)} (${debt.basis}: ${debt.components.map((c) => `${c.concept} ${usd(c.value)}`).join(" + ")})`,
      source: `derived:${ids.join("+")}`,
      sourceLabel: `Sum of ${debt.components.length} sourced components (${debt.basis})`,
      refs: ids,
    },
    ctx.runId,
  );
  ctx.trace.emit(AGENT, "fact", e.content, { refs: [e.id, ...ids] });
}

// Nigerian Exchange: audited filing figures and the dated price snapshot, both served by Zetaris.
// Every figure cites the PDF page it was read from.
const ngn = (v: number) => (Math.abs(v) >= 1e12 ? `₦${(v / 1e12).toFixed(2)}T` : `₦${(v / 1e9).toFixed(1)}B`);

async function gatherNgx(ctx: RunContext): Promise<void> {
  const { company, trace, evidence, runId, ngx } = ctx;
  const sql = `SELECT f.metric, f.value, f.unit, f.period_end, f.page, f.line, f.filing_url FROM mizan.ngx_facts f WHERE f.ticker = '${company.ticker}'`;
  trace.emit(AGENT, "tool", `Zetaris: audited NGX filing figures for ${company.ticker}`, { data: { sql } });
  const r = await zetarisQuery(sql, 50);
  trace.emit(AGENT, "tool", `Zetaris returned ${r.rows.length} rows in ${r.ms} ms`);
  for (const row of r.rows) {
    const metric = String(row.metric);
    const value = Number(row.value);
    const page = Number(row.page);
    const isShares = row.unit === "shares";
    const e = evidence.add(
      AGENT,
      {
        ticker: company.ticker,
        kind: String(row.line).includes(" + ") ? "derived" : "fact",
        metric,
        value,
        periodEnd: String(row.period_end),
        content: `${company.name} ${metric} = ${isShares ? `${(value / 1e6).toFixed(1)}M shares` : ngn(value)} (${row.line}; PDF page ${page})`,
        source: `zetaris:mizan.ngx_facts#${company.ticker}:${metric}:p${page}`,
        sourceLabel: `Zetaris mizan.ngx_facts · ${ngx?.filingTitle ?? "filing"}, page ${page}`,
        refs: [`${row.filing_url}#page=${page}`],
      },
      runId,
    );
    trace.emit(AGENT, "fact", e.content, { refs: [e.id] });
  }
}

async function gatherNgxMarketData(ctx: RunContext): Promise<void> {
  const { company, trace, evidence, runId } = ctx;
  const r = await zetarisQuery(`SELECT price, currency, price_date, source FROM mizan.ngx_prices WHERE ticker = '${company.ticker}'`, 1);
  const row = r.rows[0];
  if (!row) return void trace.emit(AGENT, "fact", "No NGX price snapshot in Zetaris");
  const price = Number(row.price);
  const p = evidence.add(AGENT, { ticker: company.ticker, kind: "price", metric: "price", value: price, periodEnd: String(row.price_date), content: `${company.ticker} NGX close ₦${price.toLocaleString()} on ${row.price_date}`, source: `zetaris:mizan.ngx_prices#${company.ticker}`, sourceLabel: `Zetaris mizan.ngx_prices (NGX close, ${row.price_date})`, refs: [String(row.source)] }, runId);
  trace.emit(AGENT, "fact", p.content, { refs: [p.id] });
  // Shares come from the filing figures gathered in parallel; wait briefly for them.
  let shares: Evidence | undefined;
  for (let i = 0; i < 80 && !shares; i++) {
    shares = evidence.find(company.ticker, runId, "sharesOutstanding").find((e) => e.value !== undefined);
    if (!shares) await new Promise((res) => setTimeout(res, 250));
  }
  if (!shares) return void trace.emit(AGENT, "fact", "Shares outstanding not found in the filing figures");
  const mcap = shares.value! * price;
  const m = evidence.add(AGENT, { ticker: company.ticker, kind: "derived", metric: "marketCap", value: mcap, periodEnd: String(row.price_date), content: `${company.name} market cap = ${ngn(mcap)} (${(shares.value! / 1e6).toFixed(1)}M shares x ₦${price.toLocaleString()})`, source: `derived:${shares.id}*${p.id}`, sourceLabel: "Shares outstanding x NGX closing price", refs: [shares.id, p.id] }, runId);
  trace.emit(AGENT, "fact", m.content, { refs: [m.id, shares.id, p.id] });
}

// Price snapshot x shares outstanding (from the company's own SEC cover-page data).
export async function gatherMarketData(ctx: RunContext): Promise<void> {
  if (ctx.market === "NGX") return gatherNgxMarketData(ctx);
  const { company, trace, evidence, runId } = ctx;
  const [facts, price] = await Promise.all([companyFacts(company.cik), fetchPrice(company.ticker)]);
  const shares = extractFinancials(facts).facts.find((f) => f.metric === "sharesOutstanding");
  const p = evidence.add(AGENT, { ticker: company.ticker, kind: "price", metric: "price", value: price.price, periodEnd: price.marketTime.slice(0, 10), content: `${company.ticker} price ${price.price} ${price.currency} at ${price.marketTime}`, source: price.source, sourceLabel: `Market price snapshot captured ${price.capturedAt}` }, runId);
  trace.emit(AGENT, "fact", p.content, { refs: [p.id] });
  if (!shares) {
    // Some multi-class filers tag no share count at all. Their cover page still reports public float
    // (market value held by non-affiliates), which understates market cap and so makes the
    // market-cap tests stricter, never looser.
    const float = (facts.facts?.dei?.EntityPublicFloat?.units?.USD ?? []).sort((a: any, b: any) => b.end.localeCompare(a.end))[0];
    if (!float) {
      trace.emit(AGENT, "fact", "Shares outstanding not found in SEC cover-page data");
      return;
    }
    const m = evidence.add(AGENT, { ticker: company.ticker, kind: "fact", metric: "marketCap", value: float.val, periodEnd: float.end, content: `${company.name} market cap proxy = ${usd(float.val)} (public float as of ${float.end}; no share count is tagged, so this understates market cap and makes the tests stricter)`, source: `sec-xbrl:dei:EntityPublicFloat#${float.accn}`, sourceLabel: `SEC cover page public float, accession ${float.accn}`, refs: [companyFactsUrl(company.cik)], confidence: 0.6 }, runId);
    trace.emit(AGENT, "fact", m.content, { refs: [m.id] });
    return;
  }
  const s = evidence.add(AGENT, { ticker: company.ticker, kind: "fact", metric: "sharesOutstanding", value: shares.value, periodEnd: shares.periodEnd, content: `${company.name} shares outstanding = ${(shares.value / 1e6).toFixed(1)}M (${shares.concept}, ${shares.periodEnd})`, source: `sec-xbrl:${shares.concept}#${shares.accession}`, sourceLabel: `SEC XBRL ${shares.concept}, accession ${shares.accession}`, refs: [companyFactsUrl(company.cik)] }, runId);
  const mcap = shares.value * price.price;
  const m = evidence.add(AGENT, { ticker: company.ticker, kind: "derived", metric: "marketCap", value: mcap, periodEnd: price.marketTime.slice(0, 10), content: `${company.name} market cap = ${usd(mcap)} (${(shares.value / 1e6).toFixed(1)}M shares x ${price.price})`, source: `derived:${s.id}*${p.id}`, sourceLabel: "Shares outstanding x market price", refs: [s.id, p.id] }, runId);
  trace.emit(AGENT, "fact", m.content, { refs: [m.id, s.id, p.id] });
}

// Nemotron tool loop for the evaluator's open data issues.
export async function investigate(ctx: RunContext, issues: Issue[], maxSteps = 7): Promise<void> {
  const { company, trace, evidence, runId } = ctx;
  const targets = [...new Set(issues.map((i) => i.metric))];
  const seen = new Set<number>();
  const remember = (v: unknown) => {
    const walk = (x: unknown): void => {
      if (typeof x === "number") seen.add(x);
      else if (typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x.trim())) seen.add(Number(x));
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(v);
  };

  const ngxMode = ctx.market === "NGX";
  const system = ngxMode
    ? `You are the Researcher agent in Mizan, a Shariah stock-screening system. Find reliable values for the metrics the evaluator flagged, for ${company.name} (Nigerian Exchange ticker ${company.ticker}). Today is ${ctx.today}.
Zetaris holds this company's audited figures in mizan.ngx_facts (columns: ticker, metric, value, unit, period_end, page, line, filing_url) and its price in mizan.ngx_prices. Query Zetaris first. If a figure is missing, use filing_search to search the company's annual report text (e.g. pattern "Borrowings|Overdraft" or "Cash and cash equivalents"); each hit shows the PDF page.
Filing figures are printed in NGN thousands or NGN millions as stated on the statement; record the value exactly as printed in the filing and say the unit in the note.
Metric definitions:
${targets.map((t) => `- ${t}: ${METRICS[t] ?? t}`).join("\n")}
Record each value with record_fact (the number must appear in a tool result), or call give_up with a reason. Be efficient: at most ${maxSteps} tool calls in total.`
    : `You are the Researcher agent in Mizan, a Shariah stock-screening system. Find reliable, recent values for the metrics the evaluator flagged, for ${company.name} (ticker ${company.ticker}, CIK ${company.cik}). Today is ${ctx.today}.
Always try Zetaris first (it is the governed data layer), then xbrl_search on the company's SEC filings. Prefer the latest 10-Q/10-K period. Balance-sheet values must be no older than 15 months; annual income values must be the latest full fiscal year.
Metric definitions:
${targets.map((t) => `- ${t}: ${METRICS[t] ?? t}`).join("\n")}
${ZETARIS_TABLES}
Record each value with record_fact (the number must appear exactly in a tool result), or call give_up with a reason.
If Zetaris returns no row for this company, do not repeat the same query: move to xbrl_search. If every xbrl_search match is marked "stale": true, the company no longer reports that figure: call give_up and say so. Be efficient: at most ${maxSteps} tool calls in total.`;
  // Tell the agent what round 1 already established, so it does not re-query empty Zetaris tables.
  const known = evidence.find(company.ticker, runId).filter((e) => e.value !== undefined && e.kind !== "note");
  const emptyTables = Object.entries(TABLE_METRIC).filter(([, m]) => !known.some((e) => e.metric === m)).map(([t]) => `mizan.${t}`);
  const user = ngxMode
    ? `Open issues from the evaluator:\n${issues.map((i) => `- [${i.metric}] ${i.problem}`).join("\n")}\nFigures already found: ${known.map((e) => `${e.metric}=${e.value}`).join(", ") || "none"}.`
    : `Open issues from the evaluator:\n${issues.map((i) => `- [${i.metric}] ${i.problem}`).join("\n")}
Already checked in Zetaris for this company: these tables have NO row for it, so do not query them again: ${emptyTables.join(", ") || "none"}.
Figures already found: ${known.map((e) => `${e.metric}=${e.value}`).join(", ") || "none"}.
Next step: use xbrl_search on the company's own SEC filings (e.g. pattern "Debt|Borrowing|NotesPayable" for debt, "Cash" for cash).`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: user }];
  const resolved = new Set<string>();

  for (let step = 0; step < maxSteps && resolved.size < targets.length; step++) {
    if (step === maxSteps - 1) messages.push({ role: "user", content: `Final step: for each unresolved metric (${targets.filter((t) => !resolved.has(t)).join(", ")}) call record_fact or give_up now.` });
    const r = await call(messages, { agent: AGENT, trace, tier: "fast", tools: ngxMode ? NGX_TOOLS : RESEARCH_TOOLS, purpose: `research step ${step + 1}: ${targets.filter((t) => !resolved.has(t)).join(", ")}` });
    const msg = r.message;
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: msg?.tool_calls });
    if (!msg?.tool_calls?.length) {
      // Nudge once; models sometimes answer in prose.
      messages.push({ role: "user", content: "Use the tools: call record_fact or give_up for each remaining metric." });
      continue;
    }
    for (const tc of msg.tool_calls) {
      let result: unknown;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        result = await runTool(tc.function.name, args);
      } catch (err) {
        result = { error: (err as Error).message };
      }
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result).slice(0, 6000) });
    }
  }
  // Unresolved metrics are noted so the evaluator does not send the same search round again.
  for (const t of targets) {
    if (resolved.has(t)) continue;
    trace.emit(AGENT, "issue", `Could not resolve ${t} within the step budget`);
    evidence.add(AGENT, { ticker: company.ticker, kind: "note", metric: t, content: `Researcher could not find a reliable current ${t} for ${company.name} in Zetaris or SEC XBRL`, source: "agent:researcher", sourceLabel: "Researcher finding" }, runId);
  }

  async function runTool(name: string, args: any): Promise<unknown> {
    if (name === "run_sql") {
      trace.emit(AGENT, "tool", `Zetaris SQL: ${String(args.sql).slice(0, 160)}`, { data: { sql: args.sql } });
      const r = await zetarisQuery(String(args.sql));
      remember(r.rows);
      return { rows: r.rows };
    }
    if (name === "filing_search") {
      trace.emit(AGENT, "tool", `Annual report search /${args.pattern}/`);
      const hits = ngxFilingSearch(company.ticker, String(args.pattern));
      // Numbers as printed ("1,080,490" or "(25,765)") become comparable values.
      remember(hits.flatMap((h) => (h.line.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g) ?? []).map((x) => Number(x.replace(/,/g, "")))));
      return { hits };
    }
    if (name === "xbrl_search") {
      trace.emit(AGENT, "tool", `SEC XBRL search /${args.pattern}/`);
      const hits = await xbrlSearch(company.cik, String(args.pattern));
      remember(hits.map((h) => h.latestValue));
      return { hits };
    }
    if (name === "record_fact") {
      const value = Number(args.value);
      const parts: { reference: string; value: number }[] = args.components ?? [];
      // NGX filings print figures in thousands or millions; accept a value whose printed form was seen.
      const wasSeen = (v: number) => seen.has(v) || (ngxMode && [1e3, 1e6].some((u) => seen.has(v / u)));
      const verified = parts.length ? parts.every((p) => wasSeen(Number(p.value))) && Math.abs(parts.reduce((a, p) => a + Number(p.value), 0) - value) < 1 : wasSeen(value);
      if (!verified) return { error: "Rejected: that value (or a component) does not appear in any tool result. Record only numbers you have seen." };
      // NGX figures are recorded as printed in the filing (NGN thousands or millions, always below
      // 10 billion for these statements); Zetaris rows are already full naira (well above that).
      const stored = ngxMode && value < 1e10 && args.metric !== "sharesOutstanding" ? value * ngxUnit(company.ticker) : value;
      const fmt = ngxMode ? ngn : usd;
      const old = evidence.find(company.ticker, runId, args.metric);
      const e = evidence.add(
        AGENT,
        {
          ticker: company.ticker,
          kind: parts.length ? "derived" : "fact",
          metric: args.metric,
          value: stored,
          periodEnd: args.period_end,
          content: `${company.name} ${args.metric} = ${fmt(stored)} for period ending ${args.period_end} (${args.reference}${parts.length ? `: ${parts.map((p) => `${p.reference} ${p.value}`).join(" + ")}` : ""}). ${args.note}`,
          source: `${args.source}:${args.reference}${args.accession ? `#${args.accession}` : ""}`,
          sourceLabel: ngxMode ? `${args.source === "zetaris" ? "Zetaris" : "Annual report"} ${args.reference}` : `${args.source === "zetaris" ? "Zetaris" : "SEC XBRL"} ${args.reference}${args.accession ? `, accession ${args.accession}` : ""}`,
          refs: ngxMode ? (ctx.ngx ? [ctx.ngx.filingUrl] : []) : [companyFactsUrl(company.cik)],
          confidence: 0.85,
        },
        runId,
      );
      for (const o of old) evidence.supersede(AGENT, o.id, e.id, `replaced after evaluator issue: ${args.note}`);
      trace.emit(AGENT, "fact", e.content, { refs: [e.id, ...old.map((o) => o.id)] });
      resolved.add(args.metric);
      return { recorded: e.id };
    }
    if (name === "give_up") {
      trace.emit(AGENT, "issue", `Gave up on ${args.metric}: ${args.reason}`);
      resolved.add(args.metric);
      evidence.add(AGENT, { ticker: company.ticker, kind: "note", metric: args.metric, content: `No reliable ${args.metric} for ${company.name}: ${args.reason}`, source: `agent:researcher`, sourceLabel: "Researcher finding" }, runId);
      return { ok: true };
    }
    return { error: `unknown tool ${name}` };
  }
}
