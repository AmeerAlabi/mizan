// Mizan UI: start a screen, stream the agents' trace, render the verdict and the evidence drawer.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`);
let currency = "$";
const money = (v, sym = currency) => (v === undefined || v === null ? "n/a" : Math.abs(v) >= 1e12 ? `${sym}${(v / 1e12).toFixed(2)}T` : Math.abs(v) >= 1e9 ? `${sym}${(v / 1e9).toFixed(1)}B` : Math.abs(v) >= 1e6 ? `${sym}${(v / 1e6).toFixed(0)}M` : `${sym}${v}`);
const AGENT_LABEL = { orchestrator: "Mizan", planner: "Planner", researcher: "Researcher", "activity-analyst": "Activity", calculator: "Calculator", evaluator: "Evaluator", risk: "Risk", reporter: "Reporter" };
const VERDICT_LABEL = { COMPLIANT: "Compliant", NON_COMPLIANT: "Not compliant", NEEDS_REVIEW: "Needs review" };

let source = null;
let lastRound = -1;

// ---- Layer status -------------------------------------------------------
async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    for (const [layer, info] of Object.entries(s)) {
      const el = document.querySelector(`.pill[data-layer="${layer}"]`);
      if (!el) continue;
      el.className = `pill ${info.status}`;
      el.title =
        layer === "meterless" ? `${info.status} · ${info.endpoint ?? ""} · fast: ${info.models?.fast ?? "?"} · deep: ${info.models?.deep ?? "?"}` :
        layer === "zetaris" ? `${info.status} · databases: ${(info.databases ?? []).join(", ")}` :
        `${info.records} evidence records · ${info.ledger} ledger entries`;
    }
  } catch { /* header stays grey */ }
}

// ---- Recent screens -----------------------------------------------------
async function loadRecent() {
  try {
    const runs = await (await fetch("/api/runs")).json();
    if (!runs.length) return;
    $("#recent").hidden = false;
    $("#recent-list").innerHTML = runs
      .map((r) => `<li><a href="#run=${esc(r.runId)}"><span><b>${esc(r.ticker)}</b> <span class="muted">${esc(r.company)}</span></span><span>${r.verdicts.map((v) => `<span class="badge ${esc(v.verdict)}" title="${esc(v.standard.toUpperCase())}">${esc(v.standard.toUpperCase())}</span>`).join(" ")}</span></a></li>`)
      .join("");
  } catch { /* optional */ }
}

// ---- Running a screen ---------------------------------------------------
async function startScreen(ticker) {
  $("#go").disabled = true;
  try {
    const res = await fetch("/api/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Could not start the screen");
    location.hash = `run=${body.runId}`;
  } catch (err) {
    alert(err.message);
  } finally {
    $("#go").disabled = false;
  }
}

function openRun(runId, pace = 0) {
  source?.close();
  lastRound = -1;
  $("#hero").classList.add("compact");
  $("#run").hidden = false;
  $("#events").innerHTML = "";
  $("#company-line").textContent = runId.split("-")[0];
  $("#verdict-body").innerHTML = `<div class="waiting"><div class="spinner" aria-hidden="true"></div><p>The planner, researcher, activity analyst and evaluator are working. Results appear here once the evaluator approves the evidence.</p></div>`;
  setStatus("live", "agents working…");

  source = new EventSource(`/api/screen/${encodeURIComponent(runId)}/events${pace ? `?pace=${pace}` : ""}`);
  source.addEventListener("trace", (m) => addEvent(JSON.parse(m.data)));
  source.addEventListener("report", (m) => {
    renderReport(JSON.parse(m.data));
    setStatus("", "finished");
    source.close();
    refreshStatus();
  });
  source.addEventListener("failed", (m) => {
    setStatus("", "failed");
    $("#verdict-body").innerHTML = `<p class="escalation">The screen could not finish: ${esc(JSON.parse(m.data).error)}</p>`;
    source.close();
  });
  source.onerror = () => source.readyState === EventSource.CLOSED || null;
}

function setStatus(cls, text) {
  const el = $("#run-status");
  el.className = `status ${cls}`;
  el.textContent = text;
}

const refsHtml = (refs = []) => refs.filter((r) => /^mem-\d+$/.test(r)).slice(0, 6).map((r) => `<button class="ref" data-ev="${esc(r)}">${esc(r)}</button>`).join("");

function addEvent(e) {
  const list = $("#events");
  if (e.round !== lastRound && e.round > 0) {
    lastRound = e.round;
    list.insertAdjacentHTML("beforeend", `<li class="round">Round ${e.round}</li>`);
  }
  if (e.type === "start" && e.summary) $("#company-line").textContent = e.summary.replace("Screening ", "");
  let text;
  // Provider retries are routine on NVIDIA's free tier: show them as one quiet line, not raw errors.
  const retry = e.type === "error" && /^Model call failed/.test(e.summary);
  if (retry) {
    const wait = e.summary.match(/retrying in (\d+)s/);
    list.insertAdjacentHTML("beforeend", `<li class="ev llm"><span class="agent a-${esc(e.agent)}"></span><div class="ev-text">NVIDIA endpoint busy · retried${wait ? ` after ${esc(wait[1])}s` : ""}</div></li>`);
    list.scrollTop = list.scrollHeight;
    return;
  }
  if (e.type === "llm") text = `${esc(e.model?.split("/").pop() ?? "model")} · ${((e.ms ?? 0) / 1000).toFixed(1)}s · ${esc(e.summary)}`;
  else if (e.type === "error") {
    // Keep fallbacks visible but readable: drop raw provider JSON.
    const clean = e.summary.replace(/:?\s*Meterless runtime error HTTP \d+:?\s*\{.*$/s, " (model unavailable)").replace(/\(Meterless runtime error HTTP \d+[^)]*\)?/g, "(model unavailable)");
    text = `<span class="kind">note</span>${esc(clean.slice(0, 200))}`;
  } else {
    text = `<span class="kind">${esc(e.type)}</span>${esc(e.summary)}`;
    if (e.data?.sql) text += `<code class="sql">${esc(e.data.sql)}</code>`;
  }
  list.insertAdjacentHTML("beforeend", `<li class="ev ${esc(e.type)}"><span class="agent a-${esc(e.agent)}">${esc(AGENT_LABEL[e.agent] ?? e.agent)}</span><div class="ev-text">${text}${e.refs?.length ? `<div>${refsHtml(e.refs)}</div>` : ""}</div></li>`);
  list.scrollTop = list.scrollHeight;
}

// ---- Verdict ------------------------------------------------------------
function testRow(t) {
  const ratio = t.ratio ?? 0;
  const scale = Math.max(t.limit * 1.6, ratio * 1.05, 0.0001);
  const width = t.ratio === null ? 0 : Math.min(100, (ratio / scale) * 100);
  return `<div class="test">
    <div class="test-top"><span>${esc(t.label)}</span><b>${pct(t.ratio)}</b></div>
    <div class="bar ${esc(t.status)}" aria-hidden="true"><span style="width:${width}%"></span><i class="limit" style="left:${(t.limit / scale) * 100}%"></i></div>
    <small><span class="badge ${esc(t.status)}">${esc(t.status)}</span> limit ${pct(t.limit)}${t.missing?.length ? ` · missing ${esc(t.missing.join(", "))}` : ""} ${refsHtml(t.evidenceIds)}</small>
  </div>`;
}

function renderReport(r) {
  currency = r.currency === "NGN" ? "₦" : "$";
  const n = r.narrative;
  const aaoifi = r.results.find((x) => x.standardId === "aaoifi") ?? r.results[0];
  const debt = aaoifi.ratios.find((t) => t.id === "debt");
  $("#company-line").textContent = `${r.company} · ${r.industry}`;
  $("#verdict-body").innerHTML = `
    ${n ? `<p class="headline">${esc(n.headline)}</p><p class="explain">${esc(n.explanation)}</p>` : ""}
    <div class="standards">
      ${r.results.map((s) => `<div class="std"><div class="std-head"><h3>${esc(s.standardName)}</h3><span class="badge ${esc(s.verdict)}">${esc(VERDICT_LABEL[s.verdict] ?? s.verdict)}</span></div>${[s.business, ...s.ratios].map(testRow).join("")}</div>`).join("")}
    </div>
    <div class="facts">
      <div class="fact"><span>Purification</span><b>${pct(r.purificationRate)}</b><small class="muted"> of dividends</small></div>
      <div class="fact"><span>Market cap</span><b>${money(debt?.denominator)}</b></div>
      <div class="fact"><span>Interest-bearing debt</span><b>${money(debt?.numerator)}</b></div>
      <div class="fact"><span>Agent rounds</span><b>${esc(r.rounds)}</b></div>
    </div>
    ${n?.key_points?.length ? `<p class="section-title">Why</p><ul class="points">${n.key_points.map((k) => `<li>${esc(k.text)} ${refsHtml(k.evidence)}</li>`).join("")}</ul>` : ""}
    ${r.escalation ? `<div class="escalation"><h4>Question for a scholar</h4><p>${esc(r.escalation.question_for_scholar)}</p><small>${esc(r.escalation.why)}</small></div>` : ""}
    ${r.unresolved?.length ? `<p class="section-title">Open issues</p><ul class="points">${r.unresolved.map((i) => `<li>${esc(i.problem)}</li>`).join("")}</ul>` : ""}
    <p class="section-title">Run</p><p class="muted">${esc(r.runId)} · trace saved to runs/${esc(r.runId)}.jsonl</p>`;
}

// ---- Evidence drawer ----------------------------------------------------
async function openEvidence(id) {
  const res = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const { evidence: e, ledger } = await res.json();
  $("#d-id").textContent = e.id;
  $("#d-title").textContent = e.content;
  const links = (e.refs ?? []).filter((x) => /^https?:/.test(x)).map((x) => `<a href="${esc(x)}" target="_blank" rel="noopener">${esc(new URL(x).hostname + new URL(x).pathname.slice(0, 40))}…</a>`).join("<br>");
  const derived = (e.refs ?? []).filter((x) => /^mem-\d+$/.test(x));
  $("#d-meta").innerHTML = `
    <dt>Source</dt><dd>${esc(e.sourceLabel)}</dd>
    ${e.value !== undefined ? `<dt>Value</dt><dd>${esc(e.metric === "nonCompliantRevenueShare" ? pct(e.value) : money(e.value))}</dd>` : ""}
    ${e.periodEnd ? `<dt>Period</dt><dd>${esc(e.periodEnd)}</dd>` : ""}
    <dt>Confidence</dt><dd>${(e.confidence * 100).toFixed(0)}%${e.supersededBy ? ` · superseded by ${refsHtml([e.supersededBy])}` : ""}</dd>
    <dt>Created by</dt><dd>${esc(AGENT_LABEL[e.createdBy] ?? e.createdBy)}</dd>
    ${derived.length ? `<dt>Built from</dt><dd>${refsHtml(derived)}</dd>` : ""}
    ${links ? `<dt>Check it</dt><dd>${links}</dd>` : ""}`;
  $("#d-ledger").innerHTML = ledger
    .map((l) => `<li><b>${esc(l.action.replace(/_/g, " "))}</b> by ${esc(AGENT_LABEL[l.actor] ?? l.actor)}<br><small class="muted">${new Date(l.timestamp).toLocaleTimeString()}${l.details ? ` · ${esc(JSON.stringify(l.details).slice(0, 140))}` : ""}</small></li>`)
    .join("");
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
}

function closeEvidence() {
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
}

// ---- Wiring -------------------------------------------------------------
$("#search").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const t = $("#ticker").value.trim().toUpperCase();
  if (t) startScreen(t);
});
for (const id of ["#examples", "#examples-ngx"]) {
  $(id).addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-t]");
    if (!b) return;
    $("#ticker").value = b.dataset.t;
    startScreen(b.dataset.t);
  });
}
document.addEventListener("click", (ev) => {
  const r = ev.target.closest(".ref[data-ev]");
  if (r) openEvidence(r.dataset.ev);
});
$("#drawer-close").addEventListener("click", closeEvidence);
$("#scrim").addEventListener("click", closeEvidence);
document.addEventListener("keydown", (ev) => ev.key === "Escape" && closeEvidence());

function route() {
  const m = location.hash.match(/run=([\w-]+)/);
  const pace = location.hash.match(/pace=(\d+)/);
  if (m) openRun(m[1], pace ? Number(pace[1]) : 0);
}
window.addEventListener("hashchange", route);
refreshStatus();
setInterval(refreshStatus, 30000);
loadRecent();
route();
