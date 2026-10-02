// Apply db/migrations/*.sql to DATABASE_URL (the app database) in order, once each.
// Usage: pnpm db:migrate   (reads .env via node --env-file)
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const dir = path.join(import.meta.dirname, "..", "db", "migrations");
const pool = new Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`applied ${f}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`${f}: ${e.message}`);
    }
  }
  console.log("migrations up to date");
} finally {
  client.release();
  await pool.end();
}
