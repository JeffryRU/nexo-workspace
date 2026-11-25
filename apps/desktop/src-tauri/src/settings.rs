//! Ajustes de la shell, por variables de entorno (sin lógica de negocio):
//!
//! - `NEXO_SHORTCUT`: atajo global para mostrar/ocultar (por omisión `Ctrl+Alt+Space`;
//!   `none`, `off`, `0` o `false` lo desactivan).
//! - `NEXO_CLOSE_TO_TRAY`: `0`, `false`, `no` u `off` hacen que cerrar la ventana la cierre de verdad
//!   en vez de ocultarla a la bandeja.

pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space";
const MAX_SHORTCUT_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub shortcut: Option<String>,
    pub close_to_tray: bool,
}

pub fn from_env(get: &dyn Fn(&str) -> Option<String>) -> Settings {
    let off = |v: &str| {
        matches!(
            v.to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    };
    let shortcut = match get("NEXO_SHORTCUT").map(|v| v.trim().to_string()) {
        None => Some(DEFAULT_SHORTCUT.to_string()),
        Some(v) if v.is_empty() || v.len() > MAX_SHORTCUT_LEN => Some(DEFAULT_SHORTCUT.to_string()),
        Some(v) if off(&v) || v.eq_ignore_ascii_case("none") => None,
        Some(v) => Some(v),
    };
    let close_to_tray = !get("NEXO_CLOSE_TO_TRAY").is_some_and(|v| off(v.trim()));
    Settings {
        shortcut,
        close_to_tray,
    }
}

pub fn from_process_env() -> Settings {
    from_env(&|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(pairs: &[(&str, &str)]) -> Settings {
        from_env(&|name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        })
    }

    #[test]
    fn valores_por_omision() {
        let s = with(&[]);
        assert_eq!(s.shortcut.as_deref(), Some("Ctrl+Alt+Space"));
        assert!(s.close_to_tray);
    }

    #[test]
    fn atajo_personalizado_y_desactivado() {
        assert_eq!(
            with(&[("NEXO_SHORTCUT", " Ctrl+Shift+N ")])
                .shortcut
                .as_deref(),
            Some("Ctrl+Shift+N")
        );
        for off in ["none", "NONE", "off", "0", "false"] {
            assert_eq!(with(&[("NEXO_SHORTCUT", off)]).shortcut, None, "{off}");
        }
    }

    #[test]
    fn cerrar_a_la_bandeja_configurable() {
        assert!(!with(&[("NEXO_CLOSE_TO_TRAY", "0")]).close_to_tray);
        assert!(!with(&[("NEXO_CLOSE_TO_TRAY", "false")]).close_to_tray);
        assert!(with(&[("NEXO_CLOSE_TO_TRAY", "1")]).close_to_tray);
    }
}

#[cfg(test)]
mod settings_adversarial {
    use super::*;

    #[test]
    fn atajo_vacio_o_enorme_vuelve_al_valor_por_omision() {
        let big = "a".repeat(10_000);
        for value in ["", "   ", big.as_str()] {
            let s = from_env(&|n| (n == "NEXO_SHORTCUT").then(|| value.to_string()));
            assert_eq!(s.shortcut.as_deref(), Some(DEFAULT_SHORTCUT));
        }
    }

    #[test]
    fn el_atajo_por_omision_es_valido_para_el_plugin() {
        use tauri_plugin_global_shortcut::Shortcut;
        assert!(DEFAULT_SHORTCUT.parse::<Shortcut>().is_ok());
        for bad in ["", "Ctrl+", "no-es-un-atajo", "Ctrl+Alt+Nada", "\0"] {
            assert!(bad.parse::<Shortcut>().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn close_to_tray_basura_se_trata_como_activado() {
        let s = from_env(&|n| (n == "NEXO_CLOSE_TO_TRAY").then(|| "quizá".to_string()));
        assert!(s.close_to_tray);
    }
}
