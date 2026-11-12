import { Pool } from "pg";

/**
 * Accesso al database dalla dashboard.
 *
 * Ogni lettura e scrittura passa da `withUser`, che apre una transazione, si
 * mette nei panni dell'utente collegato (ruolo "authenticated" + la sua
 * identità) ed esegue le query: così valgono le stesse regole RLS scritte nel
 * database, e ciascuno vede e modifica solo ciò che gli spetta.
 */

const globalForPg = globalThis as unknown as { commessePool?: Pool };

function pool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL non è impostata");
  globalForPg.commessePool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return globalForPg.commessePool;
}

export type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

export async function withUser<T>(userId: string, fn: (query: Query) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const result = await fn(async (sql, params) => (await client.query(sql, params)).rows as Row[]);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Solo per il login di sviluppo in locale: elenco degli utenti presenti. */
export async function devUsers(): Promise<Array<{ id: string; name: string; email: string }>> {
  const { rows } = await pool().query("select id, full_name, email from public.profiles order by email");
  return rows.map((r) => ({ id: String(r.id), name: String(r.full_name), email: String(r.email) }));
}
