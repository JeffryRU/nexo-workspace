//! Política de navegación de la ventana: la página solo puede ser la propia interfaz; los enlaces
//! externos `http(s)` van al navegador del sistema y todo lo demás se bloquea.

use tauri::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    /// La interfaz de Nexo (o Vite en desarrollo).
    Allow,
    /// Enlace externo `http`/`https`: se abre fuera y la ventana no navega.
    OpenExternally,
    /// Cualquier otra cosa (`file:`, `javascript:`, `data:`, `blob:`...).
    Block,
}

pub fn classify(url: &Url, dev: bool) -> Navigation {
    if !url.username().is_empty() || url.password().is_some() {
        return Navigation::Block;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    match url.scheme() {
        "tauri" if host == "localhost" => Navigation::Allow,
        "http" | "https" => {
            let is_app = host == "tauri.localhost";
            let is_vite = dev
                && url.scheme() == "http"
                && (host == "localhost" || host == "127.0.0.1")
                && url.port() == Some(5173);
            if is_app || is_vite {
                Navigation::Allow
            } else if host.is_empty() {
                Navigation::Block
            } else {
                Navigation::OpenExternally
            }
        }
        _ => Navigation::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nav(url: &str, dev: bool) -> Navigation {
        classify(&Url::parse(url).unwrap(), dev)
    }

    #[test]
    fn la_interfaz_propia_se_permite() {
        for url in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html?x=1",
        ] {
            assert_eq!(nav(url, false), Navigation::Allow, "{url}");
        }
    }

    #[test]
    fn vite_solo_en_desarrollo() {
        assert_eq!(nav("http://localhost:5173/", true), Navigation::Allow);
        assert_eq!(nav("http://127.0.0.1:5173/", true), Navigation::Allow);
        assert_eq!(
            nav("http://localhost:5173/", false),
            Navigation::OpenExternally
        );
        assert_eq!(
            nav("http://localhost:5174/", true),
            Navigation::OpenExternally
        );
    }

    #[test]
    fn enlaces_externos_http_se_abren_fuera() {
        for url in [
            "https://example.com/",
            "http://example.com/a?b=c",
            "http://127.0.0.1:4317/",
        ] {
            assert_eq!(nav(url, false), Navigation::OpenExternally, "{url}");
        }
    }
}

#[cfg(test)]
mod navigation_adversarial {
    use super::*;

    fn nav(url: &str, dev: bool) -> Navigation {
        classify(&Url::parse(url).unwrap(), dev)
    }

    #[test]
    fn esquemas_peligrosos_se_bloquean() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "blob:https://tauri.localhost/uuid",
            "ftp://example.com/",
            "ms-msdt:/id",
            "vscode://file/x",
            "about:blank",
            "tauri://evil/",
            "ws://127.0.0.1:4317/",
        ] {
            assert_eq!(nav(url, true), Navigation::Block, "{url}");
        }
    }

    #[test]
    fn imitaciones_del_host_propio_no_pasan() {
        for url in [
            "http://tauri.localhost@evil.com/",
            "https://user:pass@tauri.localhost/",
            "http://evil.com/?tauri.localhost",
            "http://tauri.localhost.evil.com/",
            "http://evil.com#@tauri.localhost",
            "http://localhost.evil.com:5173/",
        ] {
            assert_ne!(nav(url, true), Navigation::Allow, "{url}");
        }
    }

    #[test]
    fn mayusculas_y_puntos_finales() {
        assert_eq!(nav("HTTP://TAURI.LOCALHOST/", false), Navigation::Allow);
        assert_ne!(nav("http://tauri.localhost./", false), Navigation::Allow);
    }
}
