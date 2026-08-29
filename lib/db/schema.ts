import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Esquema Drizzle de la base de datos local (SQLite embebida vía
 * `tauri-plugin-sql`). Fase 4 del plan: persistencia de sesiones.
 *
 * Una sesión es "cerrada" cuando su `ended_at` > 0. El índice único
 * (process_name, started_at, ended_at) permite re-guardar sin duplicar
 * (los eventos `session_end` y el `stop_monitor` pueden contener la misma
 * sesión).
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    window_title: text("window_title").notNull(),
    process_name: text("process_name").notNull(),
    application_name: text("application_name").notNull(),
    started_at: integer("started_at").notNull(),
    ended_at: integer("ended_at").notNull(),
    duration_ms: integer("duration_ms").notNull(),
    is_idle: integer("is_idle").notNull(),
  },
  (table) => [
    uniqueIndex("sessions_unique_close").on(
      table.process_name,
      table.started_at,
      table.ended_at,
    ),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;