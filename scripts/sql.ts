// Run one Lightning SQL statement against Zetaris and print the rows.
//   npm run sql -- "SHOW LIGHTNING DATABASES"
import { runSql } from "../src/data/zetaris.ts";

const sql = process.argv.slice(2).join(" ");
if (!sql) {
  console.error('usage: npm run sql -- "<one SQL statement>"');
  process.exit(2);
}
const r = await runSql(sql, 50);
console.log(`${r.rows.length} rows via ${r.route} in ${r.ms} ms`);
if (r.rows.length) console.table(r.rows.slice(0, 50));
