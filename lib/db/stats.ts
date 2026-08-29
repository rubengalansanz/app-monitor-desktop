import type { AppStatsView, SessionView } from "@/features/monitoring/types";

/**
 * Agrega sesiones en estadísticas por aplicación, con la misma lógica
 * que el backend Rust (monitor.rs → AppStats): total, nº de sesiones,
 * primera y última aparición, ordenadas por duración desc.
 * Se usa para calcular las estadísticas del historial persistido
 * cuando el motor de monitorización no está activo.
 */
export function computeAppStats(sessions: SessionView[]): AppStatsView[] {
  const map = new Map<string, AppStatsView>();

  for (const s of sessions) {
    const prev = map.get(s.process_name);
    if (prev) {
      prev.total_duration_ms += s.duration_ms;
      prev.session_count += 1;
      prev.first_seen = Math.min(prev.first_seen, s.started_at);
      prev.last_seen = Math.max(prev.last_seen, s.ended_at);
    } else {
      map.set(s.process_name, {
        application_name: s.application_name,
        process_name: s.process_name,
        total_duration_ms: s.duration_ms,
        session_count: 1,
        first_seen: s.started_at,
        last_seen: s.ended_at,
      });
    }
  }

  return [...map.values()].sort(
    (a, b) => b.total_duration_ms - a.total_duration_ms,
  );
}