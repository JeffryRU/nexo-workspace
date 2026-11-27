//! Arranque del daemon: si no hay uno vivo lo lanza desacoplado y espera a que responda `/health`.
//!
//! Dónde están Node y el daemon (F6.1):
//! - **release**: los del paquete (recurso de Tauri `nexo/node/node[.exe]` y `nexo/daemon/daemon.mjs`, ver
//!   `tools/package`); no se usa el `node` del sistema ni el repositorio.
//! - **desarrollo** (debug): `node` del PATH y `apps/daemon/src/main.ts` del repositorio.
//!
//! En ambos, `NEXO_NODE` y `NEXO_DAEMON_ENTRY` mandan sobre lo anterior.

use crate::discovery::{discover, DaemonLocation};
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const LOG_NAME: &str = "daemon.log";
/// Carpeta del paquete dentro de los recursos de Tauri (debe coincidir con `tauri.bundle.conf.json`).
pub const BUNDLE_DIR: &str = "nexo";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum LaunchError {
    /// No se encontró el daemon (`main.ts` en desarrollo, `daemon.mjs` del paquete en release).
    EntryNotFound { path: PathBuf, bundled: bool },
    /// No se encontró el Node indicado (el empaquetado o `NEXO_NODE`).
    NodeNotFound { path: PathBuf, bundled: bool },
    /// No se pudo lanzar `node` (no instalado, sin permisos...).
    Spawn { node: OsString, reason: String },
    /// No hubo respuesta a tiempo; `last` es el último motivo del descubrimiento.
    Timeout { secs: u64, last: String },
    /// No se pudo preparar el directorio de estado o el registro.
    Io(String),
}

impl fmt::Display for LaunchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EntryNotFound {
                path,
                bundled: true,
            } => write!(
                f,
                "la instalación está incompleta: falta el daemon empaquetado en \"{}\"; reinstala Nexo Workspace",
                path.display()
            ),
            Self::EntryNotFound {
                path,
                bundled: false,
            } => write!(
                f,
                "no se encontró el daemon en \"{}\"; define NEXO_DAEMON_ENTRY con la ruta de apps/daemon/src/main.ts",
                path.display()
            ),
            Self::NodeNotFound {
                path,
                bundled: true,
            } => write!(
                f,
                "la instalación está incompleta: falta el Node empaquetado en \"{}\"; reinstala Nexo Workspace",
                path.display()
            ),
            Self::NodeNotFound {
                path,
                bundled: false,
            } => write!(
                f,
                "no se encontró el Node en \"{}\"; revisa NEXO_NODE o instala Node 24",
                path.display()
            ),
            Self::Spawn { node, reason } => write!(
                f,
                "no se pudo ejecutar node (\"{}\"): {reason}; instala Node 24 o define NEXO_NODE",
                node.to_string_lossy()
            ),
            Self::Timeout { secs, last } => write!(
                f,
                "el daemon no respondió en {secs} s ({last}); revisa daemon.log en el directorio de estado"
            ),
            Self::Io(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for LaunchError {}

#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub state_dir: PathBuf,
    pub node: OsString,
    pub entry: PathBuf,
    /// `node` y `entry` salen del paquete (afecta solo a los mensajes de error).
    pub bundled: bool,
    /// Pone `NEXO_DEV=1` para que el daemon acepte el Origin de Vite.
    pub dev: bool,
    pub timeout: Duration,
    pub poll: Duration,
    pub health_timeout: Duration,
    /// Variables extra para el daemon (pruebas).
    pub extra_env: Vec<(OsString, OsString)>,
}

impl LaunchConfig {
    /// `resource_dir`: carpeta de recursos de Tauri (en release, donde está `nexo/`).
    pub fn from_env(state_dir: PathBuf, dev: bool, resource_dir: Option<PathBuf>) -> Self {
        let env_value = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        let timeout_ms = std::env::var("NEXO_START_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|ms| (1..=300_000).contains(ms))
            .unwrap_or(15_000);
        let current_exe = std::env::current_exe().ok();
        let runtime = resolve_runtime(
            env_value("NEXO_NODE"),
            env_value("NEXO_DAEMON_ENTRY").map(PathBuf::from),
            dev,
            resource_dir.as_deref(),
            current_exe.as_deref(),
        );
        Self {
            state_dir,
            node: runtime.node,
            entry: runtime.entry,
            bundled: runtime.bundled,
            dev,
            timeout: Duration::from_millis(timeout_ms),
            poll: Duration::from_millis(150),
            health_timeout: Duration::from_millis(1000),
            extra_env: Vec::new(),
        }
    }
}

/// Node y daemon elegidos, y si salen del paquete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    pub node: OsString,
    pub entry: PathBuf,
    pub bundled: bool,
}

/// Quita el prefijo `\\?\` de las rutas de Windows: Node no lo admite bien en la ruta del script.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Ruta del Node empaquetado dentro de los recursos.
pub fn bundled_node(resource_dir: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    strip_verbatim(resource_dir)
        .join(BUNDLE_DIR)
        .join("node")
        .join(exe)
}

/// Ruta del daemon empaquetado dentro de los recursos.
pub fn bundled_entry(resource_dir: &Path) -> PathBuf {
    strip_verbatim(resource_dir)
        .join(BUNDLE_DIR)
        .join("daemon")
        .join("daemon.mjs")
}

/// Elige Node y daemon. Los overrides mandan siempre; si no, en desarrollo van el `node` del PATH y el
/// `main.ts` del repositorio y en release los del paquete (`resource_dir`, o la carpeta del ejecutable
/// si Tauri no la da). No comprueba que existan: `spawn_daemon` lo hace con un error claro.
pub fn resolve_runtime(
    node_override: Option<OsString>,
    entry_override: Option<PathBuf>,
    dev: bool,
    resource_dir: Option<&Path>,
    current_exe: Option<&Path>,
) -> Runtime {
    let resources = || -> PathBuf {
        resource_dir
            .map(Path::to_path_buf)
            .or_else(|| current_exe.and_then(|e| e.parent().map(Path::to_path_buf)))
            .unwrap_or_default()
    };
    let bundled = !dev && (node_override.is_none() || entry_override.is_none());
    let node = node_override.unwrap_or_else(|| {
        if dev {
            "node".into()
        } else {
            bundled_node(&resources()).into_os_string()
        }
    });
    let entry = match entry_override {
        Some(path) => path,
        None if dev => resolve_entry(None, current_exe),
        None => bundled_entry(&resources()),
    };
    Runtime {
        node,
        entry,
        bundled,
    }
}

/// `main.ts` del daemon: el override, o el de este repositorio (ruta fijada al compilar) o, si el
/// binario se movió, el primer `apps/daemon/src/main.ts` que aparezca subiendo desde el ejecutable.
/// Si nada existe devuelve la ruta del repositorio para que el error la muestre.
pub fn resolve_entry(override_path: Option<PathBuf>, current_exe: Option<&Path>) -> PathBuf {
    if let Some(path) = override_path {
        return path;
    }
    let from_build = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("daemon")
        .join("src")
        .join("main.ts");
    if from_build.is_file() {
        return from_build;
    }
    if let Some(exe) = current_exe {
        for dir in exe.ancestors().skip(1) {
            let candidate = dir.join("apps").join("daemon").join("src").join("main.ts");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    from_build
}

/// Lanza `node <entry>` desacoplado. Su salida va a `daemon.log` (el daemon ya redacta el token).
pub fn spawn_daemon(config: &LaunchConfig) -> Result<(), LaunchError> {
    if !config.entry.is_file() {
        return Err(LaunchError::EntryNotFound {
            path: config.entry.clone(),
            bundled: config.bundled,
        });
    }
    // `node` a secas se busca en el PATH al lanzar; una ruta (con separador) debe existir ya.
    let node_path = Path::new(&config.node);
    if node_path.components().count() > 1 && !node_path.is_file() {
        return Err(LaunchError::NodeNotFound {
            path: node_path.to_path_buf(),
            bundled: config.bundled,
        });
    }
    fs::create_dir_all(&config.state_dir)
        .map_err(|e| LaunchError::Io(format!("no se pudo crear el directorio de estado: {e}")))?;
    let log_path = config.state_dir.join(LOG_NAME);
    if fs::metadata(&log_path).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
        let mut rotated = log_path.clone().into_os_string();
        rotated.push(".1");
        let _ = fs::rename(&log_path, rotated);
    }
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| LaunchError::Io(format!("no se pudo abrir daemon.log: {e}")))?;
    let log_err = log
        .try_clone()
        .map_err(|e| LaunchError::Io(format!("no se pudo abrir daemon.log: {e}")))?;

    let mut command = Command::new(&config.node);
    command
        .arg(&config.entry)
        .env("NEXO_STATE_DIR", &config.state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    if config.dev {
        command.env("NEXO_DEV", "1");
    }
    for (key, value) in &config.extra_env {
        command.env(key, value);
    }
    detach(&mut command);
    command.spawn().map(drop).map_err(|e| LaunchError::Spawn {
        node: config.node.clone(),
        reason: e.to_string(),
    })
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `setsid` es async-signal-safe y no toca memoria del proceso tras el fork.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Devuelve el daemon vivo; si no hay, lo arranca y espera a que `/health` responda.
pub fn ensure_daemon(config: &LaunchConfig) -> Result<DaemonLocation, LaunchError> {
    if let Ok(found) = discover(&config.state_dir, config.health_timeout) {
        return Ok(found);
    }
    spawn_daemon(config)?;
    let deadline = Instant::now() + config.timeout;
    loop {
        let last = match discover(&config.state_dir, config.health_timeout) {
            Ok(found) => return Ok(found),
            Err(error) => error,
        };
        if Instant::now() >= deadline {
            return Err(LaunchError::Timeout {
                secs: config.timeout.as_secs().max(1),
                last: last.to_string(),
            });
        }
        thread::sleep(config.poll);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{daemon_json, GOOD_TOKEN};
    use crate::health::testing::{nexo_response, serve_forever};

    /// Ejecutable falso que hace de `node`: copia `$FAKE_SRC/{daemon.json,token}` al estado y
    /// anota sus argumentos y `NEXO_DEV` en `$FAKE_SRC/args.txt`.
    fn fake_node(dir: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join("fake-node.cmd");
            fs::write(
                &path,
                "@echo off\r\necho %* NEXO_DEV=%NEXO_DEV% > \"%FAKE_SRC%\\args.txt\"\r\nif exist \"%FAKE_SRC%\\daemon.json\" copy /Y \"%FAKE_SRC%\\daemon.json\" \"%NEXO_STATE_DIR%\\daemon.json\" >nul\r\nif exist \"%FAKE_SRC%\\token\" copy /Y \"%FAKE_SRC%\\token\" \"%NEXO_STATE_DIR%\\token\" >nul\r\n",
            )
            .unwrap();
            path
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("fake-node.sh");
            fs::write(
                &path,
                "#!/bin/sh\necho \"$@ NEXO_DEV=$NEXO_DEV\" > \"$FAKE_SRC/args.txt\"\n[ -f \"$FAKE_SRC/daemon.json\" ] && cp \"$FAKE_SRC/daemon.json\" \"$NEXO_STATE_DIR/daemon.json\"\n[ -f \"$FAKE_SRC/token\" ] && cp \"$FAKE_SRC/token\" \"$NEXO_STATE_DIR/token\"\nexit 0\n",
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    fn config(root: &Path, dev: bool) -> (LaunchConfig, PathBuf) {
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        let entry = root.join("main.ts");
        fs::write(&entry, "// falso").unwrap();
        let cfg = LaunchConfig {
            state_dir: root.join("state"),
            node: fake_node(root).into_os_string(),
            entry,
            bundled: false,
            dev,
            timeout: Duration::from_millis(4000),
            poll: Duration::from_millis(50),
            health_timeout: Duration::from_millis(500),
            extra_env: vec![("FAKE_SRC".into(), src.clone().into_os_string())],
        };
        (cfg, src)
    }

    #[test]
    fn arranca_el_ejecutable_con_la_ruta_y_espera_al_daemon() {
        let root = tempfile::tempdir().unwrap();
        let (cfg, src) = config(root.path(), true);
        let port = serve_forever(nexo_response());
        fs::write(src.join("daemon.json"), daemon_json(port)).unwrap();
        fs::write(src.join("token"), GOOD_TOKEN).unwrap();

        let found = ensure_daemon(&cfg).unwrap();
        assert_eq!(found.port, port);
        assert_eq!(found.token, GOOD_TOKEN);
        let args = fs::read_to_string(src.join("args.txt")).unwrap();
        assert!(args.contains("main.ts"), "{args}");
        assert!(args.contains("NEXO_DEV=1"), "{args}");
        assert!(cfg.state_dir.join(LOG_NAME).is_file());
    }

    #[test]
    fn si_ya_hay_daemon_vivo_no_lanza_nada() {
        let root = tempfile::tempdir().unwrap();
        let (cfg, src) = config(root.path(), false);
        let port = serve_forever(nexo_response());
        fs::create_dir_all(&cfg.state_dir).unwrap();
        fs::write(cfg.state_dir.join("daemon.json"), daemon_json(port)).unwrap();
        fs::write(cfg.state_dir.join("token"), GOOD_TOKEN).unwrap();
        assert_eq!(ensure_daemon(&cfg).unwrap().port, port);
        assert!(!src.join("args.txt").exists());
    }

    #[test]
    fn sin_respuesta_da_timeout_con_mensaje_claro() {
        let root = tempfile::tempdir().unwrap();
        let (mut cfg, _src) = config(root.path(), false);
        cfg.timeout = Duration::from_millis(400);
        let error = ensure_daemon(&cfg).unwrap_err();
        assert!(matches!(error, LaunchError::Timeout { .. }), "{error}");
        assert!(error.to_string().contains("daemon.log"));
    }

    #[test]
    fn resolve_entry_respeta_el_override_y_cae_al_repositorio() {
        let custom = PathBuf::from("/otra/ruta/main.ts");
        assert_eq!(resolve_entry(Some(custom.clone()), None), custom);
        let found = resolve_entry(None, None);
        assert!(
            found.ends_with(Path::new("daemon/src/main.ts")),
            "{found:?}"
        );
        assert!(
            found.is_file(),
            "en este repositorio debe existir: {found:?}"
        );
    }
}

#[cfg(test)]
mod launcher_adversarial {
    use super::*;

    fn base(root: &Path) -> LaunchConfig {
        let entry = root.join("main.ts");
        fs::write(&entry, "// x").unwrap();
        LaunchConfig {
            state_dir: root.join("state"),
            node: "nexo-node-que-no-existe-xyz".into(),
            entry,
            bundled: false,
            dev: false,
            timeout: Duration::from_millis(300),
            poll: Duration::from_millis(20),
            health_timeout: Duration::from_millis(200),
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn entry_inexistente() {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = base(root.path());
        cfg.entry = root.path().join("no-existe.ts");
        let error = ensure_daemon(&cfg).unwrap_err();
        assert!(matches!(error, LaunchError::EntryNotFound { .. }));
        assert!(error.to_string().contains("NEXO_DAEMON_ENTRY"));
    }

    #[test]
    fn entry_que_es_un_directorio() {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = base(root.path());
        cfg.entry = root.path().to_path_buf();
        assert!(matches!(
            ensure_daemon(&cfg),
            Err(LaunchError::EntryNotFound { .. })
        ));
    }

    #[test]
    fn node_inexistente_da_error_claro() {
        let root = tempfile::tempdir().unwrap();
        let error = ensure_daemon(&base(root.path())).unwrap_err();
        assert!(matches!(error, LaunchError::Spawn { .. }), "{error}");
        assert!(error.to_string().contains("NEXO_NODE"));
    }

    #[test]
    fn node_con_espacios_y_argumentos_no_se_interpreta_como_shell() {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = base(root.path());
        cfg.node = "node --eval process.exit(1) ; calc".into();
        assert!(matches!(
            ensure_daemon(&cfg),
            Err(LaunchError::Spawn { .. })
        ));
    }

    #[test]
    fn estado_que_es_un_archivo_falla_sin_panico() {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = base(root.path());
        let file = root.path().join("es-un-archivo");
        fs::write(&file, "x").unwrap();
        cfg.state_dir = file;
        assert!(ensure_daemon(&cfg).is_err());
    }

    #[test]
    fn daemon_json_corrupto_no_impide_el_arranque_pero_agota_el_tiempo() {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = base(root.path());
        fs::create_dir_all(&cfg.state_dir).unwrap();
        fs::write(cfg.state_dir.join("daemon.json"), "{corrupto").unwrap();
        cfg.node = "nexo-node-que-no-existe-xyz".into();
        assert!(matches!(
            ensure_daemon(&cfg),
            Err(LaunchError::Spawn { .. })
        ));
    }
}

#[cfg(test)]
mod bundled {
    use super::*;

    fn exe() -> Option<&'static Path> {
        None
    }

    #[test]
    fn release_usa_node_y_daemon_del_paquete() {
        let res = Path::new("recursos");
        let rt = resolve_runtime(None, None, false, Some(res), exe());
        assert!(rt.bundled);
        assert_eq!(PathBuf::from(&rt.node), bundled_node(res));
        assert_eq!(rt.entry, bundled_entry(res));
        let node = PathBuf::from(&rt.node);
        assert!(
            node.ends_with(Path::new("nexo").join("node").join(if cfg!(windows) {
                "node.exe"
            } else {
                "node"
            }))
        );
        assert!(rt
            .entry
            .ends_with(Path::new("nexo").join("daemon").join("daemon.mjs")));
    }

    #[test]
    fn release_ignora_el_node_del_sistema_y_el_repositorio() {
        let rt = resolve_runtime(None, None, false, Some(Path::new("r")), exe());
        assert_ne!(rt.node, OsString::from("node"));
        assert!(!rt.entry.ends_with("main.ts"));
    }

    #[test]
    fn desarrollo_conserva_node_del_path_y_main_ts_del_repositorio() {
        let rt = resolve_runtime(None, None, true, Some(Path::new("r")), exe());
        assert!(!rt.bundled);
        assert_eq!(rt.node, OsString::from("node"));
        assert!(rt.entry.ends_with(Path::new("daemon/src/main.ts")));
    }

    #[test]
    fn los_overrides_mandan_en_release_y_en_desarrollo() {
        for dev in [false, true] {
            let rt = resolve_runtime(
                Some("/mi/node".into()),
                Some(PathBuf::from("/mi/daemon.mjs")),
                dev,
                Some(Path::new("r")),
                exe(),
            );
            assert_eq!(rt.node, OsString::from("/mi/node"));
            assert_eq!(rt.entry, PathBuf::from("/mi/daemon.mjs"));
            assert!(!rt.bundled, "con ambos overrides nada sale del paquete");
        }
    }

    #[test]
    fn un_solo_override_sigue_usando_el_paquete_para_lo_otro() {
        let res = Path::new("r");
        let rt = resolve_runtime(Some("/mi/node".into()), None, false, Some(res), exe());
        assert_eq!(rt.node, OsString::from("/mi/node"));
        assert_eq!(rt.entry, bundled_entry(res));
        assert!(rt.bundled);
    }

    #[test]
    fn sin_carpeta_de_recursos_usa_la_del_ejecutable() {
        let exe = Path::new("/opt/nexo/nexo-desktop");
        let rt = resolve_runtime(None, None, false, None, Some(exe));
        assert_eq!(rt.entry, bundled_entry(Path::new("/opt/nexo")));
    }

    #[test]
    fn rutas_con_espacios_y_no_ascii_se_conservan() {
        let res = Path::new("/Programas/Nexo Árbol ñandú/recursos");
        let rt = resolve_runtime(None, None, false, Some(res), exe());
        assert!(rt.entry.to_string_lossy().contains("Nexo Árbol ñandú"));
        assert!(PathBuf::from(&rt.node)
            .to_string_lossy()
            .contains("Nexo Árbol ñandú"));
    }

    #[test]
    fn strip_verbatim_quita_el_prefijo_de_windows() {
        let f = |s: &str| strip_verbatim(Path::new(s)).to_string_lossy().into_owned();
        assert_eq!(f(r"\\?\C:\Program Files\Nexo"), r"C:\Program Files\Nexo");
        assert_eq!(f(r"\\?\UNC\servidor\recurso\x"), r"\\servidor\recurso\x");
        // Lo que no es un prefijo verbatim de unidad o UNC no se toca.
        assert_eq!(f(r"C:\normal"), r"C:\normal");
        assert_eq!(f("/usr/lib/nexo"), "/usr/lib/nexo");
        assert_eq!(f(r"\\?\Volume{1234}\x"), r"\\?\Volume{1234}\x");
        assert_eq!(f(""), "");
    }

    fn release_config(root: &Path, node: &Path, entry: &Path) -> LaunchConfig {
        LaunchConfig {
            state_dir: root.join("state"),
            node: node.as_os_str().to_owned(),
            entry: entry.to_path_buf(),
            bundled: true,
            dev: false,
            timeout: Duration::from_millis(300),
            poll: Duration::from_millis(20),
            health_timeout: Duration::from_millis(200),
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn paquete_ausente_da_un_error_claro_de_instalacion_incompleta() {
        let root = tempfile::tempdir().unwrap();
        let res = root.path().join("sin paquete ñ");
        let rt = resolve_runtime(None, None, false, Some(&res), exe());
        let cfg = release_config(root.path(), Path::new(&rt.node), &rt.entry);
        let error = spawn_daemon(&cfg).unwrap_err();
        assert!(matches!(
            error,
            LaunchError::EntryNotFound { bundled: true, .. }
        ));
        let text = error.to_string();
        assert!(text.contains("instalación está incompleta"), "{text}");
        assert!(text.contains("reinstala"), "{text}");
        assert!(!text.contains("NEXO_DAEMON_ENTRY"), "{text}");
    }

    #[test]
    fn falta_node_pero_hay_daemon() {
        let root = tempfile::tempdir().unwrap();
        let res = root.path();
        fs::create_dir_all(res.join("nexo").join("daemon")).unwrap();
        fs::write(bundled_entry(res), "// x").unwrap();
        let rt = resolve_runtime(None, None, false, Some(res), exe());
        let cfg = release_config(root.path(), Path::new(&rt.node), &rt.entry);
        let error = spawn_daemon(&cfg).unwrap_err();
        assert!(matches!(
            error,
            LaunchError::NodeNotFound { bundled: true, .. }
        ));
        assert!(error.to_string().contains("Node empaquetado"));
    }

    #[test]
    fn node_o_daemon_que_son_directorios_se_rechazan() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("un directorio");
        fs::create_dir_all(&dir).unwrap();
        let cfg = release_config(root.path(), &dir, &dir);
        assert!(matches!(
            spawn_daemon(&cfg),
            Err(LaunchError::EntryNotFound { .. })
        ));
        let file = root.path().join("daemon.mjs");
        fs::write(&file, "x").unwrap();
        let cfg = release_config(root.path(), &dir, &file);
        assert!(matches!(
            spawn_daemon(&cfg),
            Err(LaunchError::NodeNotFound { .. })
        ));
    }

    #[test]
    fn node_override_inexistente_con_ruta_no_dice_que_la_instalacion_esta_incompleta() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("daemon.mjs");
        fs::write(&file, "x").unwrap();
        let mut cfg = release_config(root.path(), &root.path().join("no-existe"), &file);
        cfg.bundled = false;
        let text = spawn_daemon(&cfg).unwrap_err().to_string();
        assert!(text.contains("NEXO_NODE"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn arranca_el_paquete_desde_una_ruta_con_espacios_y_no_ascii() {
        use crate::discovery::{daemon_json, GOOD_TOKEN};
        use crate::health::testing::{nexo_response, serve_forever};
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let res = root.path().join("Recursos de Nexo ñandú");
        fs::create_dir_all(res.join("nexo").join("node")).unwrap();
        fs::create_dir_all(res.join("nexo").join("daemon")).unwrap();
        fs::write(bundled_entry(&res), "// falso").unwrap();
        let node = bundled_node(&res);
        fs::write(
            &node,
            "#!/bin/sh\necho \"$@\" > \"$FAKE_SRC/args.txt\"\ncp \"$FAKE_SRC/daemon.json\" \"$NEXO_STATE_DIR/daemon.json\"\ncp \"$FAKE_SRC/token\" \"$NEXO_STATE_DIR/token\"\n",
        )
        .unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();

        let src = root.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let port = serve_forever(nexo_response());
        fs::write(src.join("daemon.json"), daemon_json(port)).unwrap();
        fs::write(src.join("token"), GOOD_TOKEN).unwrap();

        let rt = resolve_runtime(None, None, false, Some(&res), exe());
        let mut cfg = release_config(root.path(), Path::new(&rt.node), &rt.entry);
        cfg.timeout = Duration::from_millis(4000);
        cfg.extra_env = vec![("FAKE_SRC".into(), src.clone().into_os_string())];
        let found = ensure_daemon(&cfg).unwrap();
        assert_eq!(found.port, port);
        let args = fs::read_to_string(src.join("args.txt")).unwrap();
        assert!(args.contains("daemon.mjs"), "{args}");
        assert!(args.contains("Recursos de Nexo ñandú"), "{args}");
    }

    #[test]
    fn la_configuracion_de_tauri_coloca_el_paquete_donde_el_lanzador_lo_busca() {
        let text = include_str!("../tauri.bundle.conf.json");
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        let resources = json["bundle"]["resources"].as_object().unwrap();
        assert_eq!(
            resources.get("resources/nexo/").and_then(|v| v.as_str()),
            Some(format!("{BUNDLE_DIR}/").as_str())
        );
        // Node va como recurso (no como externalBin): un externalBin acabaría en /usr/bin/node al instalar el .deb.
        assert!(json["bundle"].get("externalBin").is_none());
    }

    #[test]
    fn los_instaladores_estan_activos_y_sus_archivos_existen() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let text = fs::read_to_string(manifest.join("tauri.bundle.conf.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        let bundle = &json["bundle"];
        assert_eq!(bundle["active"], true);
        for field in [
            "category",
            "publisher",
            "shortDescription",
            "longDescription",
        ] {
            assert!(
                bundle[field].as_str().is_some_and(|v| !v.is_empty()),
                "falta bundle.{field}"
            );
        }
        // Los iconos y el gancho de NSIS que declara la configuración deben existir.
        for icon in bundle["icon"].as_array().unwrap() {
            let path = manifest.join(icon.as_str().unwrap());
            assert!(path.is_file(), "falta el icono {}", path.display());
        }
        let hooks = bundle["windows"]["nsis"]["installerHooks"]
            .as_str()
            .unwrap();
        let hooks_text = fs::read_to_string(manifest.join(hooks)).unwrap();
        // El gancho detiene el daemon con la CLI empaquetada y nunca borra el estado del usuario.
        assert!(hooks_text.contains("daemon stop"));
        assert!(!hooks_text.to_lowercase().contains("rmdir"));
        assert!(!hooks_text.to_lowercase().contains("delete"));
        // Instalación por usuario: sin elevación y con el estado en %LOCALAPPDATA%\Nexo, aparte del programa.
        assert_eq!(bundle["windows"]["nsis"]["installMode"], "currentUser");
    }
}
