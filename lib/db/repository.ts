import type { SessionView } from "@/features/monitoring/types";
import { getDb, getRawDatabase } from "./client";
import { sessions, type SessionRow } from "./schema";

/**
 * Repositorio de sesiones sobre SQLite local. Toda persistencia de la
 * Fase 4 pasa por aquí; las funciones son idempotentes respecto al
 * índice único (process_name, started_at, ended_at).
 */

function toRow(s: SessionView): Omit<SessionRow, "id"> {
  return {
    window_title: s.window_title,
    process_name: s.process_name,
    application_name: s.application_name,
    started_at: s.started_at,
    ended_at: s.ended_at,
    duration_ms: s.duration_ms,
    is_idle: s.is_idle ? 1 : 0,
  };
}

/** Guarda una sesión cerrada (no duplica si ya existe). */
export async function persistSession(session: SessionView): Promise<void> {
  const drizzleDb = await getDb();
  await drizzleDb
    .insert(sessions)
    .values(toRow(session))
    .onConflictDoNothing();
}

/** Guarda una lista de sesiones cerradas, ignorando duplicados. */
export async function persistSessions(list: SessionView[]): Promise<void> {
  if (list.length === 0) return;
  const drizzleDb = await getDb();
  await drizzleDb
    .insert(sessions)
    .values(list.map(toRow))
    .onConflictDoNothing();
}

/**
 * Carga el historial persistido (orden de inserción).
 *
 * Lectura por el comando `select` del plugin en lugar de a través de
 * Drizzle: devuelve filas como objetos {columna: valor}, evitando el
 * modo values/all del adaptador que devolvía arrays (y con ellos NaNs).
 */
export async function loadPersistedSessions(): Promise<SessionView[]> {
  const raw = await getRawDatabase();
  const rows = await raw.select<Record<string, unknown>[]>(
    "SELECT id, window_title, process_name, application_name, started_at, ended_at, duration_ms, is_idle FROM sessions ORDER BY id",
  );
  return rows.map((row) => ({
    window_title: String(row.window_title),
    process_name: String(row.process_name),
    application_name: String(row.application_name),
    started_at: Number(row.started_at),
    ended_at: Number(row.ended_at),
    duration_ms: Number(row.duration_ms),
    is_idle: Number(row.is_idle) === 1,
  }));
}

/** Une dos listas de sesiones sin duplicados (por ventana+proceso+inicio+fin). */
export function mergeSessionLists(
  a: SessionView[],
  b: SessionView[],
): SessionView[] {
  const seen = new Set<string>();
  const out: SessionView[] = [];
  for (const s of [...a, ...b]) {
    const key = `${s.process_name}|${s.started_at}|${s.ended_at}`;
    if (s.ended_at > 0 && seen.has(key)) continue;
    if (s.ended_at > 0) seen.add(key);
    out.push(s);
  }
  return out;
}