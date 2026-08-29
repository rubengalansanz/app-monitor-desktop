"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ActivityState,
  AgentStatus,
  AppStatsView,
  MonitoringEvent,
  SessionView,
} from "@/features/monitoring/types";
import {
  loadPersistedSessions,
  mergeSessionLists,
  persistSession,
  persistSessions,
} from "@/lib/db/repository";
import { computeAppStats } from "@/lib/db/stats";

interface MonitoringContextValue {
  monitoring: boolean;
  active: SessionView | null;
  state: ActivityState;
  sessions: SessionView[];
  appStats: AppStatsView[];
  agentStatus: AgentStatus | null;
  agentLoading: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
}

const MonitoringContext = createContext<MonitoringContextValue | null>(null);

export function useMonitoringContext(): MonitoringContextValue {
  const ctx = useContext(MonitoringContext);
  if (!ctx) {
    throw new Error(
      "useMonitoringContext must be used within MonitoringProvider",
    );
  }
  return ctx;
}

export function MonitoringProvider({ children }: { children: ReactNode }) {
  const [monitoring, setMonitoring] = useState(false);
  const [active, setActive] = useState<SessionView | null>(null);
  const [state, setState] = useState<ActivityState>("active");
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [appStats, setAppStats] = useState<AppStatsView[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentLoading, setAgentLoading] = useState(true);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Sesiones ya persistidas en SQLite (Fase 4): se mezclan con las vivas.
  const persistedRef = useRef<SessionView[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [activeSession, history, stats] = await Promise.all([
        invoke<SessionView | null>("get_active_session"),
        invoke<SessionView[]>("get_sessions"),
        invoke<AppStatsView[]>("get_app_stats"),
      ]);
      setActive(activeSession ?? null);
      setSessions(mergeSessionLists(history ?? [], persistedRef.current));
      setAppStats(stats ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function attach() {
      try {
        const unlisten = await listen<MonitoringEvent>(
          "monitoring:event",
          (event) => {
            const payload = event.payload;
            if ("session_start" in payload) {
              setActive(payload.session_start);
            } else if ("session_end" in payload) {
              const ended = payload.session_end;
              // Fase 4: cerrar la sesión también la guarda en SQLite local.
              persistSession(ended).catch((e) =>
                console.error("persistSession:", e),
              );
              setActive(null);
              setSessions((prev) =>
                mergeSessionLists(
                  [...prev.slice(-49), ended],
                  persistedRef.current,
                ),
              );
            } else if ("activity_change" in payload) {
              setState(payload.activity_change.state);
            }
          },
        );
        if (!cancelled) unlistenRef.current = unlisten;
      } catch {
        // Fuera de Tauri.
      }
    }

    // Fase 4: al arrancar la app, recuperar el historial persistido en SQLite
    // para mostrarlo aunque el motor de monitorización no esté activo.
    (async () => {
      try {
        const persisted = await loadPersistedSessions();
        if (cancelled) return;
        persistedRef.current = persisted;
        setSessions((prev) => mergeSessionLists(prev, persisted));
        setAppStats((prev) =>
          prev.length > 0 ? prev : computeAppStats(persisted),
        );
      } catch (e) {
        console.error("loadPersistedSessions:", e);
      }
    })();

    attach();
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      try {
        const result = await invoke<AgentStatus>("agent_status");
        if (!cancelled) {
          setAgentStatus(result);
          setMonitoring(result.monitoring);
          if (result.monitoring) {
            try {
              await refresh();
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // Fuera de Tauri.
      } finally {
        if (!cancelled) setAgentLoading(false);
      }
    }
    loadStatus();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!monitoring) {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      return;
    }

    refresh();
    refreshTimerRef.current = setInterval(() => {
      refresh().catch(() => {});
    }, 3000);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [monitoring, refresh]);

  const start = async () => {
    try {
      await invoke("start_monitor");
      setMonitoring(true);
      try {
        const status = await invoke<AgentStatus>("agent_status");
        setAgentStatus(status);
      } catch {
        // ignore
      }
      setTimeout(() => {
        refresh().catch(() => {});
      }, 2000);
    } catch {
      // Fuera de Tauri o error de permisos.
    }
  };

  const stop = async () => {
    try {
      const result = await invoke<[SessionView[], AppStatsView[]]>("stop_monitor");
      const [finalSessions, finalStats] = result;
      // Fase 4: persistir todas las sesiones cerradas al detener el motor
      // (idempotente: no duplica lo ya guardado por los eventos).
      persistSessions(finalSessions).catch((e) =>
        console.error("persistSessions:", e),
      );
      setSessions(mergeSessionLists(finalSessions, persistedRef.current));
      setAppStats(finalStats);
      setActive(null);
      setMonitoring(false);
      try {
        const status = await invoke<AgentStatus>("agent_status");
        setAgentStatus(status);
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  };

  return (
    <MonitoringContext.Provider
      value={{
        monitoring,
        active,
        state,
        sessions,
        appStats,
        agentStatus,
        agentLoading,
        start,
        stop,
        refresh,
      }}
    >
      {children}
    </MonitoringContext.Provider>
  );
}
