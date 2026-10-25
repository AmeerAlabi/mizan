// Registers Mizan's live sources in Zetaris (idempotent: "already exists" is treated as done).
//   npm run zetaris:setup            # run
//   npm run zetaris:setup -- --dry   # print statements only
// Each SEC XBRL "frame" (one concept, one period, every filer) becomes a Lightning REST table plus a
// flattened view, so agents can join debt, cash, assets and revenue across companies in one query.
import { env } from "../src/env.ts";
import { runSql } from "../src/data/zetaris.ts";
import { FRAMES } from "../src/data/frames.ts";

const dry = process.argv.includes("--dry");
const rawUa = env("SEC_USER_AGENT", "mizan-hackathon research-agent").replace(/"/g, "").trim();
const ua = rawUa.includes(" ") ? rawUa : `mizan ${rawUa}`;

const statements: string[] = [
  `CREATE LIGHTNING DATABASE MIZAN_SEC DESCRIBE BY "SEC EDGAR XBRL frames used by the Mizan Shariah screening agents"`,
  `CREATE SCHEMASTORE CONTAINER mizan`,
];
for (const f of FRAMES) {
  statements.push(
    `CREATE LIGHTNING REST TABLE ${f.table}_raw FROM MIZAN_SEC REQUEST(endpoint "https://data.sec.gov/api/xbrl/frames/us-gaap/${f.concept}/USD/${f.period}.json", method "get", response_type "json", http_encoding "URLENCODED") HEADER (user-agent "${ua}") BODY ()`,
    `CREATE SCHEMASTORE VIEW ${f.table} WITH CONTAINER mizan AS SELECT lpad(CAST(d.cik AS STRING), 10, '0') AS cik, d.entityName AS entity_name, '${f.concept}' AS concept, '${f.period}' AS frame, d.\`end\` AS period_end, d.val AS value_usd, d.accn AS accession FROM mizan_sec.${f.table}_raw LATERAL VIEW explode(data) AS d`,
  );
}

for (const sql of statements) {
  const label = sql.slice(0, 90);
  if (dry) {
    console.log(sql + ";\n");
    continue;
  }
  try {
    const r = await runSql(sql, 1);
    console.log(`OK    ${label}  (${r.ms} ms)`);
  } catch (err) {
    const msg = (err as Error).message;
    if (/already exist/i.test(msg)) console.log(`SKIP  ${label}  (exists)`);
    else {
      console.log(`FAIL  ${label}\n      ${msg.slice(0, 300)}`);
      process.exitCode = 1;
    }
  }
}
