import "server-only";
import { neon } from "@neondatabase/serverless";

/** Minimal surface the app needs, so tests can run the same SQL on PGlite. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run statements atomically (non-interactive transaction). */
  transaction(statements: { text: string; params?: unknown[] }[]): Promise<void>;
}

function neonDb(envVar: string): () => Db {
  let db: Db | null = null;
  return () => {
    if (db) return db;
    const url = process.env[envVar];
    if (!url) throw new Error(`${envVar} is not set`);
    const sql = neon(url);
    db = {
      query: async <T,>(text: string, params: unknown[] = []) => (await sql.query(text, params)) as T[],
      transaction: async (statements) => {
        await sql.transaction(statements.map((s) => sql.query(s.text, s.params ?? [])));
      },
    };
    return db;
  };
}

/** The app's own database (mappings, hourly results). */
export const appDb = neonDb("DATABASE_URL");

/** The irec database — read-only role; device master data, actuals, issuances. */
export const irecDb = neonDb("IREC_DATABASE_URL");
