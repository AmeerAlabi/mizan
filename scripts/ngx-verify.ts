// Checks every figure in data/ngx/filings.json against the filing's PDF text: the number (as printed,
// e.g. "1,080,490") must appear on the cited page, or on some page for figures read from scanned
// images. Prints where each number was actually found.
//   npm run ngx:verify
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../src/env.ts";

const CACHE = path.join(ROOT, "data", "cache", "ngx");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "ngx", "filings.json"), "utf8"));

const printed = (n: number) => n.toLocaleString("en-US");
let failures = 0;

for (const c of data.companies) {
  // Prefer the text shipped in the repo (data/ngx/text); otherwise extract it from a downloaded PDF.
  const shipped = path.join(ROOT, "data", "ngx", "text", c.filing.file.replace(/\.pdf$/i, ".txt"));
  const pdf = path.join(CACHE, c.filing.file);
  let txt = shipped;
  if (!fs.existsSync(shipped)) {
    if (!fs.existsSync(pdf)) {
      console.log(`SKIP ${c.ticker}: no text in data/ngx/text and ${c.filing.file} not downloaded`);
      continue;
    }
    txt = pdf.replace(/\.pdf$/, ".txt");
    if (!fs.existsSync(txt)) execFileSync("pdftotext", ["-layout", pdf, txt]);
  }
  const pages = fs.readFileSync(txt, "latin1").split("\f");
  console.log(`\n${c.ticker} · ${c.name} · ${pages.length} pages`);
  for (const f of c.facts) {
    const needles = f.components ? f.components.map((x: { value: number }) => printed(x.value)) : [printed(f.value)];
    const where = needles.map((n: string) => pages.map((p, i) => (p.includes(n) ? i + 1 : 0)).filter(Boolean));
    const onPage = where.every((w: number[]) => w.includes(f.page));
    const anywhere = where.every((w: number[]) => w.length > 0);
    const ok = f.check === "text" ? onPage || anywhere : anywhere;
    if (!ok) failures++;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${f.metric.padEnd(20)} ${needles.join(" + ").padEnd(28)} cited p${f.page}, found on p${where.map((w: number[]) => w.join("/") || "-").join(" & ")} (${f.check})`);
  }
}
process.exitCode = failures ? 1 : 0;
