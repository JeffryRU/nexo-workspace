//! Arranque del daemon: si no hay uno vivo lo lanza desacoplado y espera a que responda `/health`.
//!
//! TODO(F6, docs/ROADMAP.md#f6--empaquetado): empaquetar Node como sidecar; hoy se usa `node` del
//! sistema (`NEXO_NODE`) y `apps/daemon/src/main.ts` del repositorio (`NEXO_DAEMON_ENTRY`).

use crate::discovery::{discover, DaemonLocation};
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const LOG_NAME: &str = "daemon.log";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum LaunchError {
    /// No se encontró `main.ts` del daemon.
    EntryNotFound(PathBuf),
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
            Self::EntryNotFound(p) => write!(
                f,
                "no se encontró el daemon en \"{}\"; define NEXO_DAEMON_ENTRY con la ruta de apps/daemon/src/main.ts",
                p.display()
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
    /// Pone `NEXO_DEV=1` para que el daemon acepte el Origin de Vite.
    pub dev: bool,
    pub timeout: Duration,
    pub poll: Duration,
    pub health_timeout: Duration,
    /// Variables extra para el daemon (pruebas).
    pub extra_env: Vec<(OsString, OsString)>,
}

impl LaunchConfig {
    pub fn from_env(state_dir: PathBuf, dev: bool) -> Self {
        let env_value = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        let timeout_ms = std::env::var("NEXO_START_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|ms| (1..=300_000).contains(ms))
            .unwrap_or(15_000);
        Self {
            state_dir,
            node: env_value("NEXO_NODE").unwrap_or_else(|| "node".into()),
            entry: resolve_entry(
                env_value("NEXO_DAEMON_ENTRY").map(PathBuf::from),
                std::env::current_exe().ok().as_deref(),
            ),
            dev,
            timeout: Duration::from_millis(timeout_ms),
            poll: Duration::from_millis(150),
            health_timeout: Duration::from_millis(1000),
            extra_env: Vec::new(),
        }
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

/// Lanza `node main.ts` desacoplado. Su salida va a `daemon.log` (el daemon ya redacta el token).
pub fn spawn_daemon(config: &LaunchConfig) -> Result<(), LaunchError> {
    if !config.entry.is_file() {
        return Err(LaunchError::EntryNotFound(config.entry.clone()));
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
        assert!(matches!(error, LaunchError::EntryNotFound(_)));
        assert!(error.to_string().contains("NEXO_DAEMON_ENTRY"));
    }

    #[test]
    fn entry_que_es_un_directorio() {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = base(root.path());
        cfg.entry = root.path().to_path_buf();
        assert!(matches!(
            ensure_daemon(&cfg),
            Err(LaunchError::EntryNotFound(_))
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
