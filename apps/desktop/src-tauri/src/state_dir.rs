//! Directorio de estado: misma resolución que el daemon (`apps/daemon/src/state-dir.ts`).

use std::path::{Path, PathBuf};

/// `NEXO_STATE_DIR`; Linux `$XDG_STATE_HOME/nexo` (solo si es absoluta) o `~/.local/state/nexo`;
/// Windows `%LOCALAPPDATA%\Nexo` (o `~\AppData\Local\Nexo`).
pub fn resolve(env: &dyn Fn(&str) -> Option<String>, windows: bool, home: &Path) -> PathBuf {
    let non_empty = |name: &str| env(name).filter(|v| !v.is_empty());
    if let Some(dir) = non_empty("NEXO_STATE_DIR") {
        return PathBuf::from(dir);
    }
    if windows {
        let base = non_empty("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        return base.join("Nexo");
    }
    let base = non_empty("XDG_STATE_HOME")
        .filter(|v| v.starts_with('/'))
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local").join("state"));
    base.join("nexo")
}

fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Directorio de estado según el entorno real del proceso.
pub fn default_dir() -> PathBuf {
    resolve(&|name| std::env::var(name).ok(), cfg!(windows), &home_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn override_manda_en_ambas_plataformas() {
        let e = env(&[("NEXO_STATE_DIR", "/tmp/x"), ("LOCALAPPDATA", "C:\\L")]);
        assert_eq!(resolve(&e, true, Path::new("/h")), PathBuf::from("/tmp/x"));
        assert_eq!(resolve(&e, false, Path::new("/h")), PathBuf::from("/tmp/x"));
    }

    #[test]
    fn linux_usa_xdg_o_local_state() {
        let home = Path::new("/home/u");
        let e = env(&[("XDG_STATE_HOME", "/s")]);
        assert_eq!(resolve(&e, false, home), PathBuf::from("/s").join("nexo"));
        let vacio = env(&[]);
        assert_eq!(
            resolve(&vacio, false, home),
            home.join(".local").join("state").join("nexo")
        );
    }

    #[test]
    fn windows_usa_localappdata_o_appdata_local() {
        let home = Path::new("home");
        let e = env(&[("LOCALAPPDATA", "L")]);
        assert_eq!(resolve(&e, true, home), PathBuf::from("L").join("Nexo"));
        assert_eq!(
            resolve(&env(&[]), true, home),
            home.join("AppData").join("Local").join("Nexo")
        );
    }

    #[test]
    fn default_dir_no_esta_vacio() {
        assert!(!default_dir().as_os_str().is_empty());
    }
}

#[cfg(test)]
mod state_dir_adversarial {
    use super::*;

    #[test]
    fn xdg_relativo_o_vacio_se_ignora() {
        let home = Path::new("/h");
        let expected = home.join(".local").join("state").join("nexo");
        for xdg in ["relativo", "", "./x", "..\\x"] {
            let e = |n: &str| (n == "XDG_STATE_HOME").then(|| xdg.to_string());
            assert_eq!(resolve(&e, false, home), expected, "xdg={xdg:?}");
        }
    }

    #[test]
    fn variables_vacias_se_tratan_como_ausentes() {
        let e = |n: &str| (n == "NEXO_STATE_DIR" || n == "LOCALAPPDATA").then(String::new);
        assert_eq!(
            resolve(&e, true, Path::new("h")),
            Path::new("h").join("AppData").join("Local").join("Nexo")
        );
    }

    #[test]
    fn valores_enormes_no_fallan() {
        let big = "a".repeat(100_000);
        let e = |n: &str| (n == "NEXO_STATE_DIR").then(|| big.clone());
        assert_eq!(resolve(&e, false, Path::new("/h")), PathBuf::from(&big));
    }
}
