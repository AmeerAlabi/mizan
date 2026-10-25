// Runs the Meterless H-MEM conformance suite against the engine entry Mizan uses (src/memory/hmem.ts).
//   npm run conformance
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "../src/env.ts";

const impl = path.join(ROOT, "src", "memory", "hmem.ts");
const runner = path.join(ROOT, "vendor", "hmem-conformance", "runner.ts");
const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), runner], { stdio: "inherit", env: { ...process.env, HMEM_IMPL: impl } });
process.exit(r.status ?? 1);
