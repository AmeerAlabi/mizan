# Mizan — Technical PRD

**Event:** GenAI Works Open Agent Hackathon 2026, Track 2 "The Agent That Can Explain Why".
**Build window:** 22 Oct 2026, 00:00 UTC to 27 Oct 2026, 23:45 UTC (submit by 27 Oct, 18:00 UTC at the latest).
**Status:** v0.1 draft, 21 Oct 2026. Sections marked **[OPEN]** need an answer before or on day 1.

---

## 1. One-liner

Mizan is a team of AI agents that investigates whether a listed company is Shariah-compliant, checks its own work, and returns a verdict in which every number, quote and conclusion links back to its source.

## 2. Problem

- Muslim investors are told to avoid companies whose core business is impermissible (alcohol, gambling, conventional interest-based finance, and so on) or whose finances depend too heavily on debt and interest.
- Checking this means reading 10-K and 10-Q filings, pulling debt, cash and interest figures, comparing them with market value, and applying a standard such as AAOIFI. Most retail investors can't do this. Screening apps give a green or red badge with no reasoning, and different apps disagree without explaining why.
- Results also go stale. A company that passed last quarter can fail after a new bond issue or a price drop, and nobody tells the investor.

**What's missing is an answer people can trust: a verdict with the evidence, the calculation, and the reasons for any uncertainty.**

## 3. Users

| Persona | Need | Hackathon priority |
|---|---|---|
| **Retail Muslim investor (primary).** Holds or wants to buy US stocks through an app. | "Can I buy this? Why? What do I need to purify from my dividends?" | Primary. The demo is built around this persona. |
| Ethical or Islamic fund analyst | Screen a watchlist quickly, with an audit trail to show a Shariah board | Secondary. Shown via watchlist and export. |
| Shariah advisor | Review the borderline cases the agent escalates | Covered by the escalation output only. |

## 4. Goals and non-goals (hackathon scope)

**Goals**
1. Screen any US-listed company on demand against **AAOIFI**, with **MSCI** as a second standard for comparison.
2. Every figure in the verdict has a source: an SEC filing accession number, a filing text quote, or a price snapshot.
3. A visible multi-agent loop: plan → research → calculate → evaluate → re-research or escalate → report.
4. A "what changed" view: re-screen after new data and explain the delta.
5. Run reliably on a curated set of 25 demo companies, live, during judging.

**Non-goals**
- Non-US exchanges (Nigeria's NGX, Saudi Tadawul and others) go on the "future" slide.
- Issuing fatwas. Mizan gives screening results, not religious rulings; borderline cases are labelled "needs scholar review".
- No brokerage or trading integration.
- No user accounts or payments.

## 5. How this scores (judging alignment)

| Criterion (pts) | How Mizan earns it |
|---|---|
| Impact (30) | A real user group that does this by hand today; the output is decision-ready (buy or avoid, plus the purification amount). |
| Technical (20) | Agent loop with an evaluator, retries, escalation and shared memory; deterministic maths kept out of the LLM; traces. |
| Innovation (15) | Evidence-first verdicts; standards side by side, with the reason they disagree; drift alerts from Meterless World Model. |
| Demo (15) | A 3-minute story with a clean pass, a clean fail, a borderline case and a "the evaluator caught stale data" moment. |
| Product & UX (10) | One search box, a verdict card, an evidence drawer and a live agent trace. |
| Sponsor tech (10) | Zetaris queries every source together; Meterless H-MEM is the evidence ledger, World Model is the company timeline; Nemotron reasons; built in Cursor. |

## 6. Screening methodology

> Thresholds below come from secondary sources (screening-provider methodology pages and an arXiv survey). **[OPEN] Verify against the AAOIFI Shariah Standard No. 21 text before 24 Oct.**

### 6.1 Business activity screen (qualitative, first gate)

- Impermissible activities: conventional banking and insurance, interest-based lending, alcohol, pork, gambling, adult entertainment, tobacco, and others per standard config.
- **Evidence:** quotes from 10-K Item 1 (Business), segment revenue where XBRL provides it, and the SIC code.
- Impermissible revenue must be **< 5%** of total revenue (AAOIFI); otherwise FAIL.
- Where the share can't be quantified (for example, a hotel group that sells alcohol), the result is **UNCERTAIN → escalate**.

### 6.2 Financial ratio screens

| Ratio | AAOIFI | MSCI (comparison) |
|---|---|---|
| Interest-bearing debt / denominator | < 30%, denominator market cap | < 33.33%, denominator total assets |
| Cash + interest-bearing securities / denominator | < 30%, market cap | < 33.33%, total assets |
| Interest and impermissible income / total revenue | < 5% | < 5% |
| Receivables (MSCI only) | — | (AR + cash) / total assets < 33.33% |

The configuration lives in `standards/*.json`, so a new standard is a data change, not a code change.

### 6.3 Verdict

- `COMPLIANT`, `NON_COMPLIANT` or `NEEDS_REVIEW`.
- Each verdict carries a confidence score and a list of failed or borderline tests.
- "Borderline" means within 10% of a limit.
- **Purification:** impermissible income ÷ total revenue × dividend received gives the amount the user should give to charity.

## 7. System architecture

```
                         ┌──────────────── Web UI (React) ────────────────┐
                         │ search · verdict card · evidence · agent trace │
                         └───────────────▲───────────────┬────────────────┘
                                         │ SSE events    │ POST /screen
                                 ┌───────┴───────────────▼────────┐
                                 │     API + Orchestrator (Node)  │
                                 │  run state machine, budgets,   │
                                 │  trace emitter                 │
                                 └──┬──────────┬──────────┬───────┘
                    ┌───────────────┘          │          └──────────────────┐
           ┌────────▼────────┐        ┌────────▼────────┐          ┌─────────▼────────┐
           │ Agents (LLM)    │        │ Calculator      │          │ Meterless        │
           │ Planner         │        │ (deterministic, │          │ H-MEM: evidence  │
           │ Researcher      │        │  pure TS)       │          │  + trust ledger  │
           │ Activity Analyst│        └─────────────────┘          │ World Model:     │
           │ Evaluator       │                                     │  company timeline│
           │ Risk/Escalation │──── tools ───┐                      └──────────────────┘
           │ Reporter        │              │
           └────────┬────────┘     ┌────────▼──────────────────────────────┐
                    │              │ Zetaris (MCP / SQL, single endpoint)  │
         NVIDIA Nemotron           │  ├─ Postgres: sec_facts, companies,   │
        (build.nvidia.com,         │  │   price_snapshots                  │
         OpenAI-compatible)        │  ├─ S3: filing text (10-K Item 1),    │
         + NV embeddings           │  │   segment JSON                     │
                                   │  └─ CSV: activity taxonomy, standards │
                                   └───────────────────────────────────────┘
                                                   ▲
                                   Ingest job (SEC EDGAR + price snapshot)
```

**Key principle:** LLMs plan, read and judge. **They never do the arithmetic.** Ratios come from the deterministic Calculator, so numbers are reproducible and testable.

## 8. Agents and the loop

| Agent | Kind | Input | Output | Tools |
|---|---|---|---|---|
| **Planner** | LLM | Ticker, standards, memory of prior runs | A plan: tests to run and data needed per test | `memory.query` |
| **Researcher** | LLM + tools | One data need | Facts with sources, written to H-MEM | `zetaris.query`, `zetaris.list_sources`, `memory.add` |
| **Activity Analyst** | LLM | Filing text chunks | Activity classification and impermissible-revenue estimate, with quotes | `zetaris.query` (S3 text), `memory.add` |
| **Calculator** | Code | Facts from H-MEM | Ratios, pass or fail per standard | none |
| **Evaluator** | LLM + rules | Facts, ratios, analysis | `APPROVE`, or a list of `ISSUE`s: missing, stale, conflicting, low confidence | `memory.query`, conflict detection |
| **Risk / Escalation** | LLM | Borderline or uncertain results | `NEEDS_REVIEW` with a reason and the question for a scholar | none |
| **Reporter** | LLM | Approved state | Plain-language verdict, purification note, citations | none |

### 8.1 Loop

```
Planner → [Researcher ∥ Activity Analyst] → Calculator → Evaluator
   ▲                                                      │
   └──────────── ISSUEs (missing/stale/conflict) ─────────┘   (max 3 rounds)
Evaluator APPROVE → borderline? → Risk agent → Reporter
                    no ─────────────────────→ Reporter
After 3 rounds without approval → NEEDS_REVIEW with the unresolved issues listed
```

### 8.2 Evaluator rules (deterministic checks first, then the LLM)

1. **Freshness:** balance-sheet facts must end within 15 months of today. The spike found JPMorgan facts from 2014 and 2018 being picked up.
2. **Completeness:** every test has all its inputs, or an explicit "not reported" with a reason.
3. **Consistency:** H-MEM conflict detection runs on facts for the same metric from different sources or periods.
4. **Sanity:** ratios inside plausible bounds; sector-aware (banks are flagged by the activity screen first).
5. **Citation:** every claim in the draft maps to a memory ID with a `source`.

### 8.3 Run budget

- At most 3 evaluation rounds.
- At most 20 LLM calls per run.
- A 90-second wall-clock limit.
- On any timeout, return a partial verdict with `NEEDS_REVIEW`; never crash.

## 9. Sponsor technology integration

### 9.1 Zetaris (required): one governed view over scattered sources

> **Confirmed 22 Oct** from `github.com/zetaris/getting-started` (cloned to `spike/zetaris-getting-started`).
>
> **Hosting**
> - This PC can't run Zetaris locally: it has 12 GB RAM (0.5 GB free), 5.9 GB free disk, and no Docker or WSL. Local needs 8 GB for Docker and 15 GB of disk.
> - **Route: Managed AWS cluster.** Use a **new AWS Free Tier account** ($100 at sign-up plus $100 from five small activities). Then in Zetaris Cloud Gateway:
>   1. Compute > Credentials > Add AWS Account > Quickstart, region `us-west-1`.
>   2. CloudFormation stack.
>   3. Create a **Mini** cluster (about 30 minutes to provision).
>   4. Sign in to the cluster's Gateway.
> - Cost: about $80 per week non-stop, covered by the credits. **Suspend the cluster when you're not building.**
> - The repo also mentions a possible **shared event instance with team prefixes**. Ask in Help Zetaris before paying for anything.
>
> **REST API (OpenAPI spec at `<instance>/redoc/docs.yaml`)**
> - Headers on every call: `X-Request-ID: <uuid>` and `X-Org-ID: <int>`.
> - Auth: `Authorization: Bearer <API key created in the Zetaris GUI>`.
> - `POST /api/v1.0/query/sql/start` with `{ "select": "<SQL>", "pageLimit": 1-100 }` → `{ records[], queryToken, totalPages }`.
> - `GET /api/v1.0/query/sql/page?queryToken&pageLimit&pageNumber` fetches further pages.
> - `DELETE /api/v1.0/query/sql/close/{queryToken}` closes the query.
> - Catalog: `GET /api/v1.0/lightning-database/databases` and `/…/file-store-tables/{table}/columns` let the Researcher **discover** sources.
> - JDBC is also available, but it needs Java and a driver JAR; REST is simpler for Node.
>
> **Ready-made EDGAR recipes in the repo**
> - `open_data/rest_apis/sql/rate_limited/01_edgar_company_facts_create.sql`: `CREATE LIGHTNING REST TABLE` reads SEC XBRL **live**, with SQL views that explode facts into rows (value, period, accession, form).
> - `11_edgar_company_profiles_create.sql` and `usl/02_sic_edgar_usl`: SEC company profiles joined to the **SIC industry hierarchy**. This is a semantic-layer data product with data-quality rules.
> - **For us:** SIC division and group give the first business-activity signal (banks 60xx, insurance 63xx, alcoholic beverages 2082–2085, gambling 7990…), via a join to our `activity_taxonomy`.
> - Each external call needs `ZETARIS_USER_AGENT="app_name email"` (an SEC requirement).
>
> **Agent rules from their `AGENTS.md`:**
> - One SQL statement per call.
> - Read-only `SHOW`, `DESCRIBE` and `SELECT` first.
> - Dry-run before any `CREATE`.
>
> **Planned source mix (shows "fragmented"):**
> 1. Live SEC REST tables in Zetaris: facts and profiles.
> 2. SIC hierarchy via `company_dns`.
> 3. Our Postgres: curated `sec_facts` cache, `activity_taxonomy`, `screen_runs`.
> 4. File source (CSV or Parquet): price snapshots and screening standards.
>
> Agents query all four through the one Zetaris endpoint.

- **Sources registered:**
  - Postgres (Supabase project `mizan`): `companies`, `sec_facts`, `price_snapshots`.
  - S3-compatible bucket: `filings/{cik}/{accession}/item1.txt` and `segments.json`.
  - CSV: `activity_taxonomy.csv` and `standards.csv`.
- **Agent access:** the Zetaris MCP tools seen in their demo (`list_sources`, `query`); exact names to be confirmed from the HackOS docs. Agents write SQL that **joins across sources in one query**, for example facts from Postgres joined to taxonomy from CSV.
- **Why it's not decoration:** without Zetaris, each source needs its own client and the agents can't discover what data exists. With it, the Researcher calls `list_sources` and decides where to look. That is Track 1 and Track 2 behaviour in one.
- **[OPEN]** Hobby tier deploys into your own cloud account. Ask on HackOS whether a hosted sandbox or credits exist. **Fallback:** keep the same SQL interface behind a `DataGateway` port so a temporary direct-Postgres adapter can stand in during development. The submission must use Zetaris.

### 9.2 Meterless (required): evidence memory, audit trail, timeline

> **Rule (updated 22 Oct):** at least one Meterless engine must be implemented in a working feature and shown with a passing test or a live demo. Mentioning an engine or adding an unused dependency doesn't count.
>
> **Our proof:**
> 1. `HMEM_IMPL=<our packages/memory entry> npx tsx conformance/runner.ts` passes. The reference already passes 13/13 on this machine.
> 2. H-MEM backs the live evidence drawer in the demo.
> 3. Start from the official starter: `npx degit meterless/meterless/templates/agentathon-starter`, then `npm run setup`, which vendors H-MEM into `vendor/`.
> 4. Memory stays on the machine; Meterless tests fail if it leaves.

- **H-MEM, verified in the spike:**
  - Every fact is stored with mandatory `source`, `confidence` and `provenance`.
  - Facts are namespaced per ticker and tagged by metric and concept.
  - The **trust ledger** records which agent created or read each fact. This becomes the "why" trail in the UI.
  - **Conflict detection** flags disagreeing facts, which the Evaluator uses.
  - **Feedback:** the Evaluator marks facts `wrong` (−0.20 confidence) when stale, so they drop out of recall.
  - **Embedder:** replace the reference hash embedder with NVIDIA embeddings. The spike showed the mock matched the wrong company.
- **World Model:** an append-only event log per company (`screened`, `filing_ingested`, `verdict_changed`). This powers "what changed since last screen" and the timeline view.
- **Scout Intent (stretch goal):** route free-text questions ("is TSLA ok for my portfolio?") to a screen, a comparison or an explanation.

### 9.3 NVIDIA (optional, adds points and the Nemotron prize)

- **Nemotron** (`nvidia/nemotron-3-super-120b-a12b` or the current equivalent on build.nvidia.com) is the reasoning and tool-calling model for all LLM agents, accessed through an OpenAI-compatible client.
- **NVIDIA embedding model** provides H-MEM retrieval.
- **[OPEN]** Confirm current model slugs and rate limits on day 1.

### 9.4 Coding tool (Cursor optional since 22 Oct)

- **Cursor is no longer required**, and the event gives no Cursor credits. We build with Claude Code.
- It's still recommended, and it's installed on this machine. Optionally open the repo in Cursor and run Claude Code inside it, so the sponsor explanation can mention Cursor at no extra cost.

### 9.5a Official Participant Setup Guide (21 Oct): the three layers

Read on 23 Oct from the PDF in `mizan-hackathon/`.

**Data: Zetaris (required)**
- REST call used by the guide: `POST {ZETARIS_REST_URL}/sql-editor/sqls/run`.
  - Body: `{ queryId: <uuid>, sql, source: "SqlEditor", limit }`.
  - Headers: `Authorization: Bearer <key>`, `X-Org-ID`, `X-Request-ID: <fresh uuid>`.
  - Response: `.data` holds the rows as arrays.
  - Fallback: the documented `/query/sql/start` API.
- Zetaris can't read files on a laptop. CSV and Parquet must go in S3; we use our own bucket in the Zetaris AWS account.
- **Pattern to follow:** "Ground every answer in Zetaris" (Zetaris facts first, web data only for context). Register public APIs (SEC) as Zetaris REST tables so one SQL query spans them.

**Build: Meterless engine (required)**
- At least one engine in a working, user-facing feature.
- Prove it with conformance, an eval or a reproducible feature test.
- The submission must name the engine and where it lives in the code.

**Power: Meterless Nightshift (REQUIRED as the primary AI provider)**
- Install the Nightshift Windows edition from meterless.ai.
- Put the NVIDIA key in **Nightshift → Setup → Providers** (never in our `.env`).
- Add Nemotron models to lanes:
  - Fast: e.g. `nvidia/nemotron-3.5-lightning-30b-a3b`
  - Deep: e.g. `nvidia/nemotron-3.5-super-vl-120b-a12b`
- **Nightshift Console** gives the base URL and Runtime token, which go in our `.env.local`:
  - `METERLESS_BASE_URL`
  - `METERLESS_RUNTIME_TOKEN`
  - `METERLESS_MODEL`
- **Contract:**
  - Headers: `Authorization: Bearer`, `meterless-app`, `meterless-scope: user`
  - `GET /v1/models` for discovery
  - `POST /v1/chat/completions` for requests
  - 180-second timeout
  - 401 or 403 reported as "unauthorized", not "offline"
  - `rt-local` rejected as a placeholder
- **NVIDIA DGX Spark award:** pin a Nemotron-backed lane (`meterless/auto` may route elsewhere). Show Nightshift run details proving Nemotron handled the request.
- **For judges:**
  1. The app solves the problem.
  2. Show the Meterless provider connection.
  3. Show one real request through Nightshift.

### 9.5 Meterless Runtime and NVIDIA key (superseded by 9.5a)

- The NVIDIA key and Meterless Runtime token go **in Nightshift and the app's settings, not in the coding tool**.
- The runtime is an OpenAI-compatible local endpoint:
  - **Base URL:** `http://127.0.0.1:8088/v1`
  - **Model IDs:** routing modes such as `meterless/auto`
  - **Headers on every call:** `Authorization: Bearer <meterless_runtime_token>` and `meterless-app: mizan`
- **Likely design:** the agents' LLM client points at the Meterless runtime, which routes to NVIDIA Nemotron. That gives one client covering both sponsors. Keep a direct build.nvidia.com fallback.
- **Note:** runtime 1.4 does **not** serve `/v1/embeddings`, so the H-MEM embedder calls NVIDIA directly.

### 9.6 Bright Data (new sponsor, optional)

- **Possible use:** fetch recent news and controversy coverage per company, for example a new acquisition that changes the business mix. The Activity Analyst would cite it.
- Stretch goal only. Adds sponsor points if time allows.

## 10. Data model (Postgres, behind Zetaris)

```sql
companies(cik text pk, ticker text unique, name text, sic text, exchange text)
sec_facts(id bigserial pk, cik text, concept text, unit text, value numeric,
          period_end date, fiscal_year int, fiscal_period text, form text,
          accession text, filed date, source_url text)
price_snapshots(ticker text, price numeric, shares_outstanding numeric,
                captured_at timestamptz, source text)
screen_runs(id uuid pk, ticker text, standards text[], verdict text,
            confidence numeric, started_at timestamptz, finished_at timestamptz,
            trace jsonb, report jsonb)
```

Agent memory lives in Meterless, not in these tables. `screen_runs` is for the UI history only.

## 11. API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/screen` | `{ ticker, standards? }` → `{ runId }` |
| GET | `/api/screen/:runId/events` | Server-sent events stream of trace events (live agent view) |
| GET | `/api/screen/:runId` | Final report JSON |
| GET | `/api/company/:ticker/timeline` | World Model events |
| GET | `/api/memory/:id` | One evidence record and its ledger history |

### 11.1 Trace event shape

```json
{ "runId": "…", "seq": 12, "ts": "…", "agent": "evaluator",
  "type": "issue", "round": 1,
  "summary": "longTermDebt period_end 2014-06-30 is stale",
  "refs": ["mem_ab12"], "tokens": 812, "ms": 1430 }
```

Traces are also written to `runs/{runId}.jsonl`, and sample runs are committed for judges.

## 12. UI

1. **Search:** a ticker box plus three example chips (one pass, one fail, one borderline).
2. **Live run:** an agent timeline streaming in, with agent avatars, round counter and issues found. This is the demo's centrepiece.
3. **Verdict card:**
   - The verdict, with AAOIFI and MSCI side by side.
   - Ratio bars against their limits.
   - The purification percentage.
   - "Why" in plain English.
4. **Evidence drawer:** click any number to see its source filing, accession link, quote and audit history.
5. **What changed:** the timeline from World Model, with the delta explained.
6. **Watchlist (stretch goal):** screen 10 tickers and export a CSV or PDF audit pack.

## 13. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 22) | Matches the Meterless reference engines; same language end to end |
| Frontend | React + Vite + Tailwind | The team's existing skills |
| Backend | Node with Hono or Express | Serves the API and the SSE stream |
| Orchestration | Hand-written state machine, or LangGraph.js if it saves time **[OPEN, decide day 1]** | Loops, branches and budgets made explicit |
| LLM client | `openai` SDK pointed at the NVIDIA base URL | Swappable model |
| Data | Supabase Postgres, Supabase Storage (S3-compatible), CSV, all via Zetaris | |
| Tests | Vitest: Calculator unit tests and golden runs on 5 tickers | |
| Deploy | Vercel (web) plus a Node host for the long-running API, or a local demo **[OPEN]** | |

## 14. Repository layout (new repo, created on 22 Oct)

```
mizan/
  apps/web/            React UI
  apps/api/            HTTP + SSE + orchestrator
  packages/agents/     planner, researcher, analyst, evaluator, risk, reporter
  packages/calc/       deterministic ratio engine + standards/*.json
  packages/data/       DataGateway port + Zetaris adapter
  packages/memory/     Meterless H-MEM + World Model wrappers
  scripts/ingest/      SEC EDGAR + price snapshot loaders
  runs/                sample traces for judges
  docs/                this PRD, architecture, CURSOR-LOG, sponsor explanation
  .env.example         placeholders only
```

## 15. Demo script (target 3:00)

| Time | Beat |
|---|---|
| 0:00 | **The hook:** "Is Tesla halal? Three apps, three answers, no reasons." |
| 0:20 | Type `AAPL`: the agents plan, research and calculate. **COMPLIANT**; click a number to show the SEC source. |
| 0:55 | Type `JPM`: the activity analyst quotes the 10-K ("banking…"). **NON_COMPLIANT** on activity, before any ratios. |
| 1:25 | **The evaluator catches stale 2014 debt data,** sends the researcher back, and the fresh figure arrives. That's the loop. |
| 1:55 | A borderline company: AAOIFI passes, MSCI fails, and Mizan explains why the standards differ. **NEEDS_REVIEW** with a question for a scholar. |
| 2:25 | What changed: a timeline and a drift alert. Show the purification amount. |
| 2:45 | Architecture slide: Zetaris, Meterless, Nemotron, Cursor. Close. |

## 16. Spike findings (21 Oct, throwaway code, not submitted)

- ✅ SEC EDGAR `companyfacts` and `company_tickers.json` work without a key. A User-Agent header is required.
- ✅ Yahoo chart endpoint gives the price. It's unofficial, so the real build snapshots prices into storage, which also feeds Zetaris.
- ✅ Meterless H-MEM reference: installs, passes its own tests (10/10), enforces `source`, and its ledger records the agent actor.
- ✅ Ratios computed: AAPL and TSLA pass; JPM fails all three ratio tests.
- ⚠️ The H-MEM reference embedder is a hash mock: recall for "AAPL debt" returned JPM facts. **Fix:** filter by namespace or tag and use NVIDIA embeddings.
- ⚠️ XBRL concept fallback picked **deprecated concepts from 2014 and 2018** for JPM. **Fix:** a freshness rule in the Evaluator, plus a concept priority list per sector.
- ✅ H-MEM conformance runner works locally: 13/13 checks pass on the reference engine (22 Oct).
- ⏳ Not yet tested: Zetaris connection, Nemotron tool calling, Meterless Runtime, World Model engine.

## 17. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Zetaris needs a paid cloud deployment or takes days to provision | Medium | Ask HackOS on day 0; `DataGateway` adapter so other work isn't blocked |
| XBRL data is messy (concept names vary, banks report differently) | High | Curated 25-company demo set; concept priority lists; the Evaluator catches gaps |
| Nemotron tool calling is unreliable | Medium | Strict JSON schemas, retries, temperature 0; model adapter allows a fallback model |
| The live demo fails during judging | Medium | Cache last good runs; recorded video is the primary artefact; commit sample traces |
| Methodology errors damage credibility | Medium | Verify AAOIFI text; label outputs "screening, not a fatwa"; show the standard version used |
| Scope creep | High | Section 4 non-goals; watchlist and Scout Intent are stretch goals only |

## 18. Build plan

| Day (UTC) | Deliverable | Done when |
|---|---|---|
| **22 Oct** | Repo, CI and `.env.example`; ingest 25 companies to Postgres and storage; Zetaris sources registered; Nemotron call working; Calculator with unit tests | `zetaris.query` returns AAPL facts; Calculator tests pass |
| **23 Oct** | Planner, Researcher and Calculator loop end to end via CLI; H-MEM writes with sources; trace JSONL | CLI `screen AAPL` prints a verdict with citations |
| **24 Oct** | Evaluator with deterministic rules plus the LLM; retries; Activity Analyst on 10-K Item 1; Risk agent; NVIDIA embeddings in H-MEM | JPM stale-data loop reproduces; a borderline case escalates |
| **25 Oct** | API, SSE and the UI (search, live trace, verdict, evidence drawer); World Model timeline | Full demo flow works in the browser |
| **26 Oct** | Hardening: 25-ticker golden run, failure fallbacks, caching; README, slides, sponsor explanation; **record the video** | Clean clone-and-run works; video is under 4 minutes |
| **27 Oct** | Buffer, final polish; **submit by 18:00 UTC** | Submission confirmed on HackOS |

## 19. Submission checklist

- [ ] Demo video, 1–4 minutes, showing Zetaris and Meterless visibly in use.
- [ ] Slide deck covering: problem, users, solution, architecture, stack, sponsor use and what's unique about it, visuals, future work.
- [ ] Public GitHub repo with a README covering setup, usage and dependencies, plus `.env.example`.
- [ ] Sponsor explanation covering Zetaris, Meterless, Cursor (with `CURSOR-LOG.md`) and NVIDIA.
- [ ] Sample inputs and outputs, and traces in `runs/`.
- [ ] Pre-existing components declared: Meterless reference engines (Apache 2.0) and open-source libraries. No pre-window project code.
- [ ] Secret scan run; no keys in the repo.

## 20. Open questions

1. Zetaris: is there a hosted sandbox or credits, or do we need our own AWS, Google Cloud or Azure account? What are the exact MCP tool names and auth method?
2. Meterless: is there an official package, or do we vendor the reference engines? Does the World Model have a reference build like H-MEM?
3. The AAOIFI Standard 21 exact text: is the denominator market cap or the 12- or 36-month average market cap?
4. Team: solo or with others? Who owns the UI, the agents, and the video and slides?
5. Hosting for the live demo: deployed, or local plus video?
