import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/lib/db";

/** In-process Postgres exposing the same Db surface as the Neon client. */
export async function memoryDb(setup?: string): Promise<Db & { pg: PGlite }> {
  const pg = new PGlite();
  if (setup) await pg.exec(setup);
  return {
    pg,
    query: async <T,>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows,
    transaction: async (statements) => {
      await pg.transaction(async (tx) => {
        for (const s of statements) await tx.query(s.text, s.params ?? []);
      });
    },
  };
}

export async function appTestDb() {
  const dir = path.join(import.meta.dirname, "..", "..", "db", "migrations");
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(path.join(dir, f), "utf8"));
  return memoryDb(sql.join("\n"));
}

/** The slice of the irec schema this app reads (see irec-remastered/schema.sql). */
export const IREC_SCHEMA = `
CREATE TABLE companies (company_id serial PRIMARY KEY, company_name text NOT NULL);
CREATE TABLE devices (device_id serial PRIMARY KEY, device_meta_id text, project_description text,
  project_capacity float, htsc_no text, status varchar(10), company_id int REFERENCES companies(company_id));
CREATE TABLE devices_monthly_data (device_id int REFERENCES devices(device_id), period int,
  actual_gen numeric(15,6), banked_units numeric(15,6), eligible_gen numeric(15,6), PRIMARY KEY (device_id, period));
CREATE TABLE issuances (issuance_id serial PRIMARY KEY, device_id int NOT NULL REFERENCES devices(device_id),
  period int NOT NULL, issued_units numeric(15,6) NOT NULL);
`;
