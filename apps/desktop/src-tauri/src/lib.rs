//! Shell de escritorio de Nexo Workspace (ADR 0001: Rust delgado).
//!
//! Solo ventana, bandeja, atajo global, instancia única y arrancar el daemon si no está vivo.
//! La interfaz es `apps/web`; el estado vive en el daemon, así que salir de aquí no lo detiene.

mod discovery;
mod health;
mod launcher;
mod navigation;
mod notifications;
mod settings;
mod state_dir;

use launcher::{ensure_daemon, LaunchConfig};
use navigation::Navigation;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const MAIN_WINDOW: &str = "main";
/// Tamaño inicial y mínimo de la ventana (px lógicos). El mínimo deja trabajar en estrecho: por debajo de 760 px la
/// barra lateral es un cajón y por debajo de 520 los diálogos ocupan toda la ventana (ver docs/ARCHITECTURE.md).
const WINDOW_SIZE: (f64, f64) = (1280.0, 860.0);
const WINDOW_MIN_SIZE: (f64, f64) = (480.0, 360.0);

struct AppState {
    launch: LaunchConfig,
    /// Serializa `daemon_info` para no lanzar dos daemons a la vez (el cerrojo del daemon es la red de seguridad).
    starting: Arc<Mutex<()>>,
}

/// Lo que la página necesita para conectarse. Sin `Debug`: el token nunca se registra.
#[derive(Serialize)]
struct DaemonInfo {
    port: u16,
    token: String,
}

/// Entrega puerto y token del daemon, arrancándolo si no corre.
#[tauri::command]
async fn daemon_info(state: State<'_, AppState>) -> Result<DaemonInfo, String> {
    let launch = state.launch.clone();
    let starting = Arc::clone(&state.starting);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = starting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ensure_daemon(&launch)
    })
    .await
    .map_err(|e| format!("falló la tarea de arranque del daemon: {e}"))?
    .map(|found| DaemonInfo {
        port: found.port,
        token: found.token,
    })
    .map_err(|e| e.to_string())
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
}

fn toggle_main(app: &AppHandle) {
    let visible = main_window(app)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
    if visible {
        hide_main(app);
    } else {
        show_main(app);
    }
}

fn open_external(url: &tauri::Url) {
    // Solo llegan `http`/`https` (ver `navigation::classify`).
    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("nexo: no se pudo abrir el enlace externo: {error}");
    }
}

fn build_window(app: &AppHandle, dev: bool) -> tauri::Result<WebviewWindow> {
    let handle_nav = move |url: &tauri::Url| match navigation::classify(url, dev) {
        Navigation::Allow => true,
        Navigation::OpenExternally => {
            open_external(url);
            false
        }
        Navigation::Block => false,
    };
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Nexo Workspace")
        .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
        .min_inner_size(WINDOW_MIN_SIZE.0, WINDOW_MIN_SIZE.1)
        .on_navigation(handle_nav)
        .on_new_window(move |url, _features| {
            match navigation::classify(&url, dev) {
                Navigation::OpenExternally => open_external(&url),
                Navigation::Allow | Navigation::Block => {}
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Ocultar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
    let mut tray = TrayIconBuilder::with_id("nexo")
        .tooltip("Nexo Workspace")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "hide" => hide_main(app),
            // Salir cierra la ventana; el daemon (proceso aparte) sigue con sus terminales.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Registra el atajo global; si está ocupado o es inválido avisa y sigue sin él.
fn setup_shortcut(app: &AppHandle, shortcut: &str) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let parsed: Shortcut = match shortcut.parse() {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("nexo: atajo global \"{shortcut}\" no válido ({error}); sigo sin atajo");
            return;
        }
    };
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, pressed, event| {
            if *pressed == parsed && event.state() == ShortcutState::Pressed {
                toggle_main(app);
            }
        })
        .build();
    if let Err(error) = app.plugin(plugin) {
        eprintln!("nexo: no se pudo iniciar el atajo global ({error}); sigo sin atajo");
        return;
    }
    if let Err(error) = app.global_shortcut().register(parsed) {
        eprintln!(
            "nexo: el atajo global \"{shortcut}\" no está disponible ({error}); sigo sin atajo"
        );
    }
}

pub fn run() {
    let settings = settings::from_process_env();
    let dev = cfg!(debug_assertions);
    let close_to_tray = settings.close_to_tray;
    let shortcut = settings.shortcut.clone();

    tauri::Builder::default()
        // Debe ir primero: la segunda ejecución enfoca la ventana existente y termina.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![daemon_info])
        .setup(move |app| {
            // En release los recursos (Node y daemon empaquetados) cuelgan de la carpeta de recursos de Tauri.
            let launch = LaunchConfig::from_env(
                state_dir::default_dir(),
                dev,
                app.path().resource_dir().ok(),
            );
            app.manage(AppState {
                launch,
                starting: Arc::new(Mutex::new(())),
            });
            let handle = app.handle();
            build_window(handle, dev)?;
            setup_tray(handle)?;
            if let Some(shortcut) = &shortcut {
                setup_shortcut(handle, shortcut);
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if close_to_tray && window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error al ejecutar Nexo Workspace");
}
