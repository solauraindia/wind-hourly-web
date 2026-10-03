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

/** irec with two of the Q2 devices and a few months of actuals/issuances. */
export async function irecFixture() {
  return memoryDb(`${IREC_SCHEMA}
    INSERT INTO companies (company_name) VALUES ('Rajaguru Spinning Mills Pvt Ltd'), ('Mothi Spinner Pvt Ltd');
    INSERT INTO devices (device_meta_id, project_description, project_capacity, htsc_no, status, company_id) VALUES
      ('1.5MWIND016', '1.5 MW at Seepalakottai Village, HTSC 0157', 1.5, '59244760157', 'Active', 1),
      ('2.7MES20003', '2.7 MW Uthiyur Village, HTSC No.2297', 2.7, '39264392297', 'Active', 2);
    INSERT INTO devices_monthly_data (device_id, period, actual_gen, eligible_gen) VALUES
      (1, 202604, 109.061, 109.061), (1, 202605, 382.025, 382.025), (1, 202606, 708.754, 512.005),
      (1, 202603, 99, 99);
    INSERT INTO issuances (device_id, period, issued_units) VALUES
      (1, 202604, 100), (1, 202604, 9.061), (1, 202606, 512.005), (1, 202603, 77);
  `);
}
