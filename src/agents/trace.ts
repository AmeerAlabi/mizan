// Run trace: every agent step is an event, streamed to listeners (CLI, UI) and appended to
// runs/<runId>.jsonl so judges can replay how a verdict was reached.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../env.ts";

export type AgentName = "orchestrator" | "planner" | "researcher" | "activity-analyst" | "calculator" | "evaluator" | "risk" | "reporter";

export interface TraceEvent {
  runId: string;
  seq: number;
  ts: string;
  round: number;
  agent: AgentName;
  type: "start" | "plan" | "tool" | "fact" | "issue" | "decision" | "result" | "error" | "llm";
  summary: string;
  refs?: string[];
  data?: unknown;
  model?: string;
  ms?: number;
}

export type Listener = (e: TraceEvent) => void;

export class Trace {
  private seq = 0;
  readonly events: TraceEvent[] = [];
  round = 0;
  private file: string;

  constructor(readonly runId: string, private listeners: Listener[] = []) {
    const dir = path.join(ROOT, "runs");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${runId}.jsonl`);
  }

  on(listener: Listener) {
    this.listeners.push(listener);
  }

  emit(agent: AgentName, type: TraceEvent["type"], summary: string, extra: Partial<Pick<TraceEvent, "refs" | "data" | "model" | "ms">> = {}): TraceEvent {
    const e: TraceEvent = { runId: this.runId, seq: ++this.seq, ts: new Date().toISOString(), round: this.round, agent, type, summary, ...extra };
    this.events.push(e);
    fs.appendFileSync(this.file, JSON.stringify(e) + "\n");
    for (const l of this.listeners) l(e);
    return e;
  }
}
