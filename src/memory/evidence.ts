// Evidence store on Meterless H-MEM. Every number or quote an agent relies on becomes an H-MEM record
// with a mandatory source and provenance; the trust ledger records which agent created, read,
// rejected or superseded it. Lookups are exact (ticker + metric tags) rather than similarity search,
// because a screen must never mix up two companies' figures.
import path from "node:path";
import { HMEM, type MemoryRecord } from "./hmem.ts";
import { ROOT } from "../env.ts";

export type EvidenceKind = "fact" | "quote" | "price" | "derived" | "note";

export interface EvidenceInput {
  ticker: string;
  kind: EvidenceKind;
  metric: string;
  content: string; // human-readable statement of the evidence
  value?: number;
  periodEnd?: string;
  source: string; // e.g. "zetaris:mizan.assets_q accn 0000320193-26-000020" or a filing URL
  sourceLabel: string;
  refs?: string[]; // URLs a person can open to check
  confidence?: number;
  extraTags?: string[];
}

export interface Evidence {
  id: string;
  ticker: string;
  kind: EvidenceKind;
  metric: string;
  content: string;
  value?: number;
  periodEnd?: string;
  source: string;
  sourceLabel: string;
  refs: string[];
  confidence: number;
  supersededBy?: string;
  createdBy: string;
  createdAt: number;
}

const tag = (rec: MemoryRecord, key: string) => rec.tags.find((t) => t.startsWith(`${key}:`))?.slice(key.length + 1);

function toEvidence(rec: MemoryRecord, createdBy: string): Evidence {
  const value = tag(rec, "value");
  return {
    id: rec.id,
    ticker: tag(rec, "ticker") ?? "",
    kind: (tag(rec, "kind") ?? "note") as EvidenceKind,
    metric: tag(rec, "metric") ?? "",
    content: rec.content,
    value: value === undefined ? undefined : Number(value),
    periodEnd: tag(rec, "period"),
    source: rec.source,
    sourceLabel: rec.provenance.label,
    refs: rec.provenance.refs ?? [],
    confidence: rec.confidence,
    supersededBy: rec.supersededBy,
    createdBy,
    createdAt: rec.timestamp,
  };
}

export class EvidenceStore {
  readonly hmem: HMEM;

  constructor(persistDir = path.join(ROOT, ".hmem")) {
    this.hmem = new HMEM({ persistDir, actor: "mizan" });
  }

  // The reference services take a fixed actor at construction; switch it per call so the ledger
  // names the agent that actually performed each action.
  private as<T>(agent: string, fn: () => T): T {
    const services = [this.hmem.store, this.hmem.retrieval, this.hmem.conflicts] as unknown as { actor: string }[];
    const previous = services.map((s) => s.actor);
    services.forEach((s) => (s.actor = agent));
    try {
      return fn();
    } finally {
      services.forEach((s, i) => (s.actor = previous[i]));
    }
  }

  add(agent: string, e: EvidenceInput, runId: string): Evidence {
    const tags = [`ticker:${e.ticker}`, `kind:${e.kind}`, `metric:${e.metric}`, `run:${runId}`, ...(e.extraTags ?? [])];
    if (e.value !== undefined) tags.push(`value:${e.value}`);
    if (e.periodEnd) tags.push(`period:${e.periodEnd}`);
    const rec = this.as(agent, () =>
      this.hmem.add({
        content: e.content,
        type: "factual",
        layer: "working",
        tags,
        confidence: e.confidence ?? 0.9,
        source: e.source,
        provenance: { origin: "document", learnedAt: Date.now(), label: e.sourceLabel, refs: e.refs },
        goalRunId: runId,
      }),
    );
    return toEvidence(rec, agent);
  }

  get(id: string): Evidence | undefined {
    const rec = this.hmem.store.get(id);
    return rec ? toEvidence(rec, this.creator(id)) : undefined;
  }

  private creator(id: string): string {
    return this.hmem.ledger.history(id).find((e) => e.action === "create")?.actor ?? "mizan";
  }

  // Current (non-superseded) evidence for a ticker in this run, optionally for one metric.
  find(ticker: string, runId: string, metric?: string): Evidence[] {
    return this.hmem.store
      .all()
      .filter((r) => r.tags.includes(`ticker:${ticker}`) && r.tags.includes(`run:${runId}`) && !r.supersededBy && (!metric || r.tags.includes(`metric:${metric}`)))
      .map((r) => toEvidence(r, this.creator(r.id)));
  }

  // Evidence from earlier runs on the same ticker: what the agents learned last time.
  previous(ticker: string, runId: string): Evidence[] {
    return this.hmem.store
      .all()
      .filter((r) => r.tags.includes(`ticker:${ticker}`) && !r.tags.includes(`run:${runId}`) && !r.supersededBy)
      .map((r) => toEvidence(r, this.creator(r.id)));
  }

  read(agent: string, ids: string[], purpose: string): void {
    for (const id of ids) {
      if (!this.hmem.store.get(id)) continue;
      this.hmem.store.touch(id);
      this.hmem.ledger.log(id, "read", agent, { details: { purpose } });
    }
  }

  // The evaluator rejects evidence (stale, implausible): H-MEM "wrong" feedback lowers its confidence.
  reject(agent: string, id: string, reason: string): void {
    this.as(agent, () => this.hmem.feedback(id, "wrong"));
    this.hmem.ledger.log(id, "update", agent, { details: { rejected: reason } });
  }

  // A better figure replaces an older one; the old record is kept, marked supersededBy.
  supersede(agent: string, oldId: string, newId: string, reason: string): void {
    this.as(agent, () => this.hmem.store.update(oldId, { supersededBy: newId }));
    this.hmem.ledger.log(oldId, "conflict_resolved", agent, { details: { winner: newId, reason } });
  }

  conflict(agent: string, a: string, b: string, reason: string): void {
    this.hmem.ledger.log(a, "conflict_detected", agent, { details: { with: b, reason } });
  }

  history(id: string) {
    return this.hmem.ledger.history(id);
  }
}
