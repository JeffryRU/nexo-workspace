//! Descubrimiento del daemon: lee `daemon.json` y `token` y comprueba `/health`.
//! Replica `packages/client/src/node/discovery.ts` (mismos límites y errores).

use crate::health::check_health;
use serde::Deserialize;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const MAX_DAEMON_FILE_BYTES: u64 = 4096;
const MAX_TOKEN_FILE_BYTES: u64 = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    /// No hay `daemon.json`.
    NotRunning,
    /// Hay archivos pero el daemon no responde.
    Stale(String),
    /// Archivos ilegibles, enormes, enlaces simbólicos o con contenido no válido.
    Corrupt(String),
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRunning => write!(f, "Nexo no está corriendo"),
            Self::Stale(why) | Self::Corrupt(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// Forma que escribe el daemon. Los campos desconocidos se ignoran.
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // se validan todos aunque solo se use el puerto
struct DaemonFile {
    version: String,
    port: u64,
    pid: u64,
    #[serde(rename = "startedAt")]
    started_at: String,
}

/// Dónde está el daemon vivo. El `Debug` oculta el token.
#[derive(Clone, PartialEq, Eq)]
pub struct DaemonLocation {
    pub port: u16,
    pub pid: u32,
    pub token: String,
}

impl fmt::Debug for DaemonLocation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DaemonLocation")
            .field("port", &self.port)
            .field("pid", &self.pid)
            .field("token", &"<oculto>")
            .finish()
    }
}

/// Valida el contenido de `daemon.json`; devuelve `(puerto, pid)`.
pub fn parse_daemon_file(raw: &str) -> Result<(u16, u32), DiscoveryError> {
    let corrupt = || DiscoveryError::Corrupt("daemon.json no es válido".into());
    let file: DaemonFile = serde_json::from_str(raw).map_err(|_| corrupt())?;
    if file.version.is_empty() || file.version.len() > 64 || file.started_at.len() > 40 {
        return Err(corrupt());
    }
    let port = u16::try_from(file.port)
        .ok()
        .filter(|p| *p >= 1)
        .ok_or_else(corrupt)?;
    let pid = u32::try_from(file.pid)
        .ok()
        .filter(|p| *p >= 1)
        .ok_or_else(corrupt)?;
    Ok((port, pid))
}

/// Recorta espacios y exige `[A-Za-z0-9_-]{16,512}` (rechaza vacío y saltos de línea internos).
pub fn parse_token(raw: &str) -> Result<String, DiscoveryError> {
    let token = raw.trim();
    let valid = (16..=512).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(token.to_string())
    } else {
        Err(DiscoveryError::Corrupt("el token no es válido".into()))
    }
}

/// Lee un archivo regular pequeño: rechaza enlaces simbólicos, no regulares y tamaños excesivos.
/// `Ok(None)` si no existe.
fn read_small_file(path: &Path, max: u64) -> Result<Option<String>, DiscoveryError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(DiscoveryError::Corrupt(
                "no se pudo leer el directorio de estado".into(),
            ))
        }
    };
    if !meta.is_file() {
        return Err(DiscoveryError::Corrupt(
            "se esperaba un archivo regular".into(),
        ));
    }
    if meta.len() > max {
        return Err(DiscoveryError::Corrupt(
            "el archivo es demasiado grande".into(),
        ));
    }
    let read_err = || DiscoveryError::Corrupt("no se pudo leer el archivo".into());
    let file = fs::File::open(path).map_err(|_| read_err())?;
    let mut bytes = Vec::new();
    // `take(max + 1)`: si el archivo creció tras `metadata`, se detecta.
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| read_err())?;
    if bytes.len() as u64 > max {
        return Err(DiscoveryError::Corrupt(
            "el archivo es demasiado grande".into(),
        ));
    }
    String::from_utf8(bytes).map(Some).map_err(|_| read_err())
}

/// Localiza un daemon vivo en `state_dir`.
pub fn discover(
    state_dir: &Path,
    health_timeout: Duration,
) -> Result<DaemonLocation, DiscoveryError> {
    let Some(raw) = read_small_file(&state_dir.join("daemon.json"), MAX_DAEMON_FILE_BYTES)? else {
        return Err(DiscoveryError::NotRunning);
    };
    let (port, pid) = parse_daemon_file(&raw)?;
    let Some(token_raw) = read_small_file(&state_dir.join("token"), MAX_TOKEN_FILE_BYTES)? else {
        return Err(DiscoveryError::Stale("falta el token del daemon".into()));
    };
    let token = parse_token(&token_raw)?;
    if !check_health(port, health_timeout) {
        return Err(DiscoveryError::Stale(
            "daemon.json existe pero el daemon no responde".into(),
        ));
    }
    Ok(DaemonLocation { port, pid, token })
}

#[cfg(test)]
pub(crate) const GOOD_TOKEN: &str = "abcDEF0123456789_-xyzXYZ";

#[cfg(test)]
pub(crate) fn daemon_json(port: u16) -> String {
    format!(
        "{{\"version\":\"0.0.0\",\"port\":{port},\"pid\":1234,\"startedAt\":\"2026-01-01T00:00:00Z\"}}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::testing::{nexo_response, serve_forever};

    const T: Duration = Duration::from_millis(1000);

    fn dir_with(daemon: Option<&str>, token: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(d) = daemon {
            fs::write(dir.path().join("daemon.json"), d).unwrap();
        }
        if let Some(t) = token {
            fs::write(dir.path().join("token"), t).unwrap();
        }
        dir
    }

    #[test]
    fn daemon_valido_se_descubre_con_token_recortado() {
        let port = serve_forever(nexo_response());
        let dir = dir_with(
            Some(&daemon_json(port)),
            Some(&format!("  {GOOD_TOKEN}\r\n")),
        );
        let found = discover(dir.path(), T).unwrap();
        assert_eq!(found.port, port);
        assert_eq!(found.pid, 1234);
        assert_eq!(found.token, GOOD_TOKEN);
    }

    #[test]
    fn campos_extra_se_ignoran() {
        let raw = r#"{"version":"1","port":4317,"pid":9,"startedAt":"x","futuro":{"a":1}}"#;
        assert_eq!(parse_daemon_file(raw).unwrap(), (4317, 9));
    }

    #[test]
    fn sin_daemon_json_es_not_running() {
        let dir = dir_with(None, None);
        assert_eq!(discover(dir.path(), T), Err(DiscoveryError::NotRunning));
        let missing = dir.path().join("no-existe");
        assert_eq!(discover(&missing, T), Err(DiscoveryError::NotRunning));
    }

    #[test]
    fn daemon_json_obsoleto_es_stale() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let dir = dir_with(Some(&daemon_json(port)), Some(GOOD_TOKEN));
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Stale(_))
        ));
    }

    #[test]
    fn sin_token_es_stale() {
        let dir = dir_with(Some(&daemon_json(4317)), None);
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Stale(_))
        ));
    }

    #[test]
    fn el_debug_no_muestra_el_token() {
        let loc = DaemonLocation {
            port: 1,
            pid: 2,
            token: GOOD_TOKEN.into(),
        };
        assert!(!format!("{loc:?}").contains(GOOD_TOKEN));
    }
}

#[cfg(test)]
mod discovery_adversarial {
    use super::*;

    const T: Duration = Duration::from_millis(500);

    #[test]
    fn daemon_json_corrupto() {
        for raw in [
            "",
            "no es json",
            "{",
            "[]",
            "null",
            "{}",
            r#"{"version":"1","port":"4317","pid":1,"startedAt":"x"}"#,
            r#"{"version":"1","port":4317,"pid":1}"#,
            r#"{"version":"","port":4317,"pid":1,"startedAt":"x"}"#,
        ] {
            assert!(
                matches!(parse_daemon_file(raw), Err(DiscoveryError::Corrupt(_))),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn puertos_fuera_de_rango() {
        for port in ["0", "65536", "70000", "-1", "1.5", "99999999999999999999"] {
            let raw = format!(r#"{{"version":"1","port":{port},"pid":1,"startedAt":"x"}}"#);
            assert!(parse_daemon_file(&raw).is_err(), "puerto {port}");
        }
        for port in ["1", "65535"] {
            let raw = format!(r#"{{"version":"1","port":{port},"pid":1,"startedAt":"x"}}"#);
            assert!(parse_daemon_file(&raw).is_ok(), "puerto {port}");
        }
    }

    #[test]
    fn pid_invalido() {
        for pid in ["0", "-3", "4294967296"] {
            let raw = format!(r#"{{"version":"1","port":80,"pid":{pid},"startedAt":"x"}}"#);
            assert!(parse_daemon_file(&raw).is_err(), "pid {pid}");
        }
    }

    #[test]
    fn version_y_fecha_demasiado_largas() {
        let long = "v".repeat(65);
        let raw = format!(r#"{{"version":"{long}","port":80,"pid":1,"startedAt":"x"}}"#);
        assert!(parse_daemon_file(&raw).is_err());
        let long = "d".repeat(41);
        let raw = format!(r#"{{"version":"1","port":80,"pid":1,"startedAt":"{long}"}}"#);
        assert!(parse_daemon_file(&raw).is_err());
    }

    #[test]
    fn tokens_invalidos() {
        let huge = "a".repeat(513);
        let mut bad: Vec<String> = vec![
            String::new(),
            "   \n  ".into(),
            "corto".into(),
            "abcdefghij\nklmnopqrstuv".into(),
            "abcdefghijklmnop qrstuv".into(),
            "abcdefghijklmnopqrstuv\0".into(),
            "tokén-con-acentos-123456".into(),
            "a".repeat(15),
        ];
        bad.push(huge);
        for t in bad {
            assert!(parse_token(&t).is_err(), "{t:?}");
        }
        assert!(parse_token(&"a".repeat(512)).is_ok());
        assert!(parse_token(&"a".repeat(16)).is_ok());
    }

    #[test]
    fn archivos_enormes_se_rechazan_sin_leerlos() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("daemon.json"), "x".repeat(5000)).unwrap();
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Corrupt(_))
        ));

        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("daemon.json"),
            crate::discovery::daemon_json(4317),
        )
        .unwrap();
        fs::write(dir.path().join("token"), "a".repeat(100_000)).unwrap();
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Corrupt(_))
        ));
    }

    #[test]
    fn token_con_salto_interno_es_corrupto() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("daemon.json"),
            crate::discovery::daemon_json(4317),
        )
        .unwrap();
        fs::write(dir.path().join("token"), "abcdefghijklmnop\nqrstuvwxyz").unwrap();
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Corrupt(_))
        ));
    }

    #[test]
    fn daemon_json_directorio_no_es_archivo_regular() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("daemon.json")).unwrap();
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Corrupt(_))
        ));
    }

    #[test]
    fn utf8_invalido_es_corrupto() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("daemon.json"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Corrupt(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn enlace_simbolico_se_rechaza() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.json");
        fs::write(&real, crate::discovery::daemon_json(4317)).unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("daemon.json")).unwrap();
        assert!(matches!(
            discover(dir.path(), T),
            Err(DiscoveryError::Corrupt(_))
        ));
    }
}
