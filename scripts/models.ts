// Lists the models Nightshift exposes (filter with an argument, e.g. `npm run models -- nemotron`).
import { checkStatus, loadConfig } from "../src/llm/meterless.ts";

const filter = (process.argv[2] ?? "").toLowerCase();
const s = await checkStatus(loadConfig());
console.log(`status: ${s.status}`);
for (const m of s.models.filter((id) => id.toLowerCase().includes(filter))) console.log(`  ${m}`);
