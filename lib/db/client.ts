import Database from "@tauri-apps/plugin-sql";
import {
  drizzle,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

/**
 * Cliente SQLite de la app.
 *
 * La base de datos la hostea el proceso Rust (tauri-plugin-sql) en el
 * directorio de datos de la aplicación (`sqlite:app-monitor.db`), y la
 * capa del frontend la consume a través del adaptador sqlite-proxy de
 * Drizzle. Así el "backend dentro de la app" guarda y lee localmente.
 */

const DATABASE_URL = "sqlite:app-monitor.db";

// DDL inicial (equivalente a schema.ts). Se ejecuta una sola vez; Drizzle
// se usa a partir de ahí para las operaciones tipadas.
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_title TEXT NOT NULL,
  process_name TEXT NOT NULL,
  application_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  is_idle INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_unique_close
  ON sessions (process_name, started_at, ended_at);
`;

let raw: Database | null = null;
let db: SqliteRemoteDatabase<typeof schema> | null = null;

async function ensureRaw(): Promise<Database> {
  if (raw) return raw;

  if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
    // Fuera de Tauri (p. ej. dev en navegador): lanzar para que el caller
    // lo capture y la persistencia quede inactiva, igual que invoke/listen.
    throw new Error("SQLite solo está disponible dentro de Tauri");
  }

  const loaded = await Database.load(DATABASE_URL);
  await loaded.execute(SCHEMA_DDL);
  raw = loaded;
  return raw;
}

/**
 * Conexión "cruda" del plugin. Úsala para LECTURAS: su comando `select`
 * devuelve filas como objetos con nombre de columna, sin la ambigüedad
 * de modo (all/values) del adaptador Drizzle.
 */
export async function getRawDatabase(): Promise<Database> {
  return ensureRaw();
}

/** Devuelve el cliente Drizzle (singleton), ejecutando el DDL la primera vez. */
export async function getDb(): Promise<SqliteRemoteDatabase<typeof schema>> {
  if (db) return db;

  const loaded = await ensureRaw();
  raw = loaded;

  db = drizzle(
    async (sql, params, method) => {
      if (!raw) throw new Error("Base de datos no inicializada");

      if (method === "run") {
        // Escrituras: execute() devuelve filas afectadas + último id.
        const r = (await raw.execute(sql, params)) as {
          rowsAffected?: number;
          lastInsertId?: number;
        };
        return {
          rows: [] as Record<string, unknown>[],
          rowsAffected: r.rowsAffected ?? 0,
          lastInsertRowid: BigInt(r.lastInsertId ?? 0),
        };
      }

      // Lecturas: en plugin-sql 2.x los SELECT deben ir por db.select()
      // (execute() solo devuelve rowsAffected, nunca filas).
      const rows = await raw.select<Record<string, unknown>[]>(sql, params);

      if (method === "values") {
        return { rows: rows.map((row) => Object.values(row)) };
      }

      const selected =
        method === "all" ? rows : rows[0] ? [rows[0]] : [];
      return { rows: selected };
    },
    { schema },
  );

  return db;
}