// App Monitor — agente nativo (Rust / Tauri)
//
// Fase 2: shell de escritorio e IPC.
// Fase 3: motor de monitorización (ventana activa, proceso, inactividad,
//         bloqueo y suspensión).
//
// Organización:
// - monitor.rs: máquina de estados de sesiones (independiente de plataforma).
// - windows.rs: captura de ventana activa e inactividad (Win32, solo Windows).
// - power.rs:   detección de bloqueo/suspensión (Win32, solo Windows).

mod monitor;
#[cfg(windows)]
mod power;
#[cfg(windows)]
mod windows;

use monitor::{ActivityState, Monitor};
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Umbral de inactividad por defecto: 2 minutos.
const DEFAULT_IDLE_THRESHOLD_MS: u64 = 120_000;

/// Estado del monitor gestionado por Tauri.
/// Usa `Arc` internos para poder compartirlo con los hilos de monitoreo.
#[derive(Clone)]
pub struct MonitorState {
    inner: std::sync::Arc<Mutex<Monitor>>,
    running: std::sync::Arc<Mutex<bool>>,
}

impl MonitorState {
    fn new() -> Self {
        MonitorState {
            inner: std::sync::Arc::new(Mutex::new(Monitor::new(DEFAULT_IDLE_THRESHOLD_MS))),
            running: std::sync::Arc::new(Mutex::new(false)),
        }
    }
}

/// Evento emitido al frontend cuando cambia la actividad.
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitoringEvent {
    /// Se inició una sesión nueva.
    SessionStart(SessionView),
    /// Se cerró la sesión activa (cambio de app, bloqueo o suspensión).
    SessionEnd(SessionView),
    /// El estado de actividad del sistema cambió.
    ActivityChange { state: ActivityState },
}

/// Vista serializable de una sesión para el frontend.
#[derive(Clone, Serialize)]
pub struct SessionView {
    pub window_title: String,
    pub process_name: String,
    pub application_name: String,
    pub started_at: u64,
    pub ended_at: u64,
    pub duration_ms: u64,
    pub is_idle: bool,
}

impl From<&monitor::Session> for SessionView {
    fn from(s: &monitor::Session) -> Self {
        SessionView {
            window_title: s.window_title.clone(),
            process_name: s.process_name.clone(),
            application_name: s.application_name.clone(),
            started_at: s.started_at,
            ended_at: s.ended_at,
            duration_ms: s.duration_ms,
            is_idle: s.is_idle,
        }
    }
}

/// Estadísticas agregadas por aplicación.
#[derive(Clone, Serialize)]
pub struct AppStatsView {
    pub application_name: String,
    pub process_name: String,
    pub total_duration_ms: u64,
    pub session_count: u64,
    pub first_seen: u64,
    pub last_seen: u64,
}

impl From<&monitor::AppStats> for AppStatsView {
    fn from(s: &monitor::AppStats) -> Self {
        AppStatsView {
            application_name: s.application_name.clone(),
            process_name: s.process_name.clone(),
            total_duration_ms: s.total_duration_ms,
            session_count: s.session_count,
            first_seen: s.first_seen,
            last_seen: s.last_seen,
        }
    }
}

/// Estado del agente nativo (comando heredado de la Fase 2).
#[derive(Serialize)]
pub struct AgentStatus {
    pub ready: bool,
    pub platform: String,
    pub version: String,
    pub monitoring: bool,
}

#[tauri::command]
fn agent_status(state: State<MonitorState>) -> AgentStatus {
    AgentStatus {
        ready: true,
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        monitoring: *state.running.lock().unwrap(),
    }
}

/// Inicia el motor de monitorización.
#[tauri::command]
fn start_monitor(app: AppHandle, state: State<MonitorState>) -> Result<(), String> {
    {
        let mut running = state.running.lock().unwrap();
        if *running {
            return Ok(());
        }
        *running = true;
    }

    // Clonamos el estado gestionado (los Arc internos) para los hilos.
    let state = state.clone();
    let app_power = app.clone();
    let state_power = state.clone();
    let state_running = state.clone();

    // Listener de bloqueo/suspensión que alimenta el estado del monitor.
    #[cfg(windows)]
    {
        use power::PowerEvent;
        let (tx, rx) = std::sync::mpsc::channel::<PowerEvent>();
        power::spawn_power_listener(tx);
        let inner_for_power = state_power.inner.clone();
        let running_for_power = state_running.running.clone();
        std::thread::spawn(move || {
            for ev in rx {
                if !*running_for_power.lock().unwrap() {
                    break;
                }
                let now = monitor::now_millis();
                let mut m = inner_for_power.lock().unwrap();
                let new_state = match ev {
                    PowerEvent::Lock => ActivityState::Locked,
                    PowerEvent::Unlock | PowerEvent::Resume => ActivityState::Active,
                    PowerEvent::Suspend => ActivityState::Suspended,
                };
                m.set_activity(new_state, now);
                let _ = app_power.emit(
                    "monitoring:event",
                    MonitoringEvent::ActivityChange { state: new_state },
                );
            }
        });
    }

    // Bucle principal de muestreo de la ventana activa.
    let app_loop = app.clone();
    let inner_loop = state.inner.clone();
    let running_loop = state.running.clone();
    std::thread::spawn(move || loop {
        if !*running_loop.lock().unwrap() {
            break;
        }

        let now = monitor::now_millis();
        let threshold = inner_loop.lock().unwrap().idle_threshold_ms();

        #[cfg(windows)]
        let (active, idle) = {
            let idle_ms = windows::idle_time_ms();
            let is_idle = idle_ms >= threshold;
            let active = windows::get_active_window();
            (active, is_idle)
        };
        #[cfg(not(windows))]
        let (active, idle): (Option<()>, bool) = (None, false);

        let mut m = inner_loop.lock().unwrap();
        let new_state = if idle {
            ActivityState::Idle
        } else {
            ActivityState::Active
        };
        m.set_activity(new_state, now);

        if let Some(win) = active {
            let app_name = humanize_app_name(&win.process_name);
            let closed = m.tick(
                win.title.clone(),
                win.process_name.clone(),
                app_name,
                now,
            );
            if let Some(session) = closed {
                let _ = app_loop.emit(
                    "monitoring:event",
                    MonitoringEvent::SessionEnd(SessionView::from(&session)),
                );
            }
            if let Some(s) = m.active_session() {
                let _ = app_loop.emit(
                    "monitoring:event",
                    MonitoringEvent::SessionStart(SessionView::from(s)),
                );
            }
        }
        drop(m);

        std::thread::sleep(Duration::from_millis(1000));
    });

    Ok(())
}

/// Detiene el motor de monitorización y devuelve las estadísticas finales.
#[tauri::command]
fn stop_monitor(state: State<MonitorState>) -> Result<(Vec<SessionView>, Vec<AppStatsView>), String> {
    let now = monitor::now_millis();
    let mut m = state.inner.lock().unwrap();
    m.close_active(now);
    let sessions = m.sessions().iter().map(SessionView::from).collect();
    let stats = m.app_stats().iter().map(AppStatsView::from).collect();
    m.clear();
    *state.running.lock().unwrap() = false;
    Ok((sessions, stats))
}

/// Devuelve la sesión activa actual, si existe.
#[tauri::command]
fn get_active_session(state: State<MonitorState>) -> Option<SessionView> {
    let m = state.inner.lock().unwrap();
    m.active_session().map(SessionView::from)
}

/// Devuelve el historial de sesiones cerradas.
#[tauri::command]
fn get_sessions(state: State<MonitorState>) -> Vec<SessionView> {
    let m = state.inner.lock().unwrap();
    m.sessions().iter().map(SessionView::from).collect()
}

/// Devuelve estadísticas agregadas por aplicación.
#[tauri::command]
fn get_app_stats(state: State<MonitorState>) -> Vec<AppStatsView> {
    let m = state.inner.lock().unwrap();
    m.app_stats().iter().map(AppStatsView::from).collect()
}

/// Convierte un nombre de proceso (p. ej. "chrome.exe") en un nombre legible.
fn humanize_app_name(process_name: &str) -> String {
    let base = process_name
        .rsplit('\\')
        .next()
        .unwrap_or(process_name)
        .trim_end_matches(".exe")
        .trim_end_matches(".EXE");
    if base.is_empty() {
        return process_name.to_string();
    }
    let mut chars = base.chars();
    let first = chars.next().unwrap().to_uppercase().collect::<String>();
    format!("{}{}", first, chars.as_str())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(MonitorState::new())
        .invoke_handler(tauri::generate_handler![
            agent_status,
            start_monitor,
            stop_monitor,
            get_active_session,
            get_sessions,
            get_app_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
