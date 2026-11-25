//! `GET /health` contra el loopback con un cliente HTTP/1.1 mínimo (sin dependencias).
//! Es un daemon de Nexo si responde 200, trae `X-Nexo-Daemon: 1` y el cuerpo `{ "ok": true }`.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: usize = 8192;

/// Comprueba `/health` en `127.0.0.1:port`. Cualquier fallo (red, tiempo, formato) es `false`.
pub fn check_health(port: u16, timeout: Duration) -> bool {
    check_health_inner(port, timeout).unwrap_or(false)
}

fn check_health_inner(port: u16, timeout: Duration) -> std::io::Result<bool> {
    let deadline = Instant::now() + timeout;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Nexo-Daemon: 1\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(request.as_bytes())?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(false);
        }
        stream.set_read_timeout(Some(left))?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_RESPONSE_BYTES {
                    return Ok(false);
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(is_nexo_health(&buf))
}

/// Valida una respuesta HTTP completa (cabecera + cuerpo).
pub fn is_nexo_health(raw: &[u8]) -> bool {
    let Some(split) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
        return false;
    };
    let Ok(head) = std::str::from_utf8(&raw[..split]) else {
        return false;
    };
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap_or_default();
    let mut parts = status.split(' ');
    if !parts.next().is_some_and(|v| v.starts_with("HTTP/1.")) || parts.next() != Some("200") {
        return false;
    }
    let mut marker = false;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "x-nexo-daemon" && value == "1" {
            marker = true;
        } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    if !marker {
        return false;
    }
    let body = if chunked {
        match dechunk(body) {
            Some(b) => b,
            None => return false,
        }
    } else {
        body.to_vec()
    };
    serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .is_some_and(|v| v.get("ok") == Some(&serde_json::Value::Bool(true)))
}

fn dechunk(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let end = data.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&data[..end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        data = &data[end + 2..];
        if size == 0 {
            return Some(out);
        }
        if data.len() < size.checked_add(2)? {
            return None;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! Servidor HTTP falso para pruebas.
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    /// Atiende una sola conexión con `reply(request)`; devuelve el puerto.
    pub fn serve_once(reply: impl FnOnce(&str) -> Vec<u8> + Send + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let out = reply(&request);
                let _ = stream.write_all(&out);
                thread::sleep(Duration::from_millis(50));
            }
        });
        port
    }

    /// Atiende todas las conexiones con la misma respuesta (hasta que acaba el proceso de prueba).
    pub fn serve_forever(response: Vec<u8>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(&response);
            }
        });
        port
    }

    pub fn ok_response(body: &str, extra: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    pub fn nexo_response() -> Vec<u8> {
        ok_response(
            "{\"ok\":true,\"version\":\"0.0.0\"}",
            "X-Nexo-Daemon: 1\r\n",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    const T: Duration = Duration::from_millis(1500);

    #[test]
    fn daemon_valido_responde_true_y_recibe_la_cabecera() {
        let port = serve_once(|req| {
            assert!(req.starts_with("GET /health HTTP/1.1\r\n"));
            assert!(req.contains("X-Nexo-Daemon: 1"));
            nexo_response()
        });
        assert!(check_health(port, T));
    }

    #[test]
    fn sin_cabecera_marcadora_es_false() {
        let port = serve_once(|_| ok_response("{\"ok\":true}", ""));
        assert!(!check_health(port, T));
    }

    #[test]
    fn puerto_cerrado_es_false() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!check_health(port, T));
    }

    #[test]
    fn servidor_lento_agota_el_tiempo() {
        let port = serve_once(|_| {
            std::thread::sleep(Duration::from_millis(800));
            nexo_response()
        });
        let started = Instant::now();
        assert!(!check_health(port, Duration::from_millis(200)));
        assert!(started.elapsed() < Duration::from_millis(700));
    }

    #[test]
    fn cuerpo_chunked_valido() {
        let body = "{\"ok\":true}";
        let raw = format!(
            "HTTP/1.1 200 OK\r\nX-Nexo-Daemon: 1\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
            body.len()
        );
        assert!(is_nexo_health(raw.as_bytes()));
    }
}

#[cfg(test)]
mod health_adversarial {
    use super::testing::*;
    use super::*;

    const T: Duration = Duration::from_millis(1500);

    fn raw(status: &str, headers: &str, body: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\n{headers}\r\n{body}").into_bytes()
    }

    #[test]
    fn estados_distintos_de_200_son_false() {
        for status in ["404 Not Found", "500 Oops", "301 Moved", "204 No Content"] {
            let r = raw(status, "X-Nexo-Daemon: 1\r\n", "{\"ok\":true}");
            assert!(!is_nexo_health(&r), "{status}");
        }
    }

    #[test]
    fn cabecera_con_valor_distinto_o_nombre_en_mayusculas() {
        let ok = raw("200 OK", "x-NEXO-daemon:  1 \r\n", "{\"ok\":true}");
        assert!(is_nexo_health(&ok));
        for bad in ["0", "2", "true", "", "11"] {
            let r = raw(
                "200 OK",
                &format!("X-Nexo-Daemon: {bad}\r\n"),
                "{\"ok\":true}",
            );
            assert!(!is_nexo_health(&r), "valor {bad:?}");
        }
    }

    #[test]
    fn cuerpo_invalido_o_sin_ok() {
        for body in [
            "",
            "no es json",
            "{}",
            "{\"ok\":false}",
            "{\"ok\":\"true\"}",
            "[]",
            "null",
        ] {
            let r = raw("200 OK", "X-Nexo-Daemon: 1\r\n", body);
            assert!(!is_nexo_health(&r), "cuerpo {body:?}");
        }
    }

    #[test]
    fn respuestas_malformadas_no_entran_en_panico() {
        for r in [
            &b""[..],
            b"HTTP/1.1",
            b"\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nsin-dos-puntos\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nX-Nexo-Daemon: 1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
            b"HTTP/1.1 200 OK\r\nX-Nexo-Daemon: 1\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\nx",
            &[0xff, 0xfe, b'\r', b'\n', b'\r', b'\n'],
        ] {
            assert!(!is_nexo_health(r));
        }
    }

    #[test]
    fn respuesta_enorme_se_rechaza() {
        let big = "x".repeat(100_000);
        let port = serve_once(move |_| ok_response(&big, "X-Nexo-Daemon: 1\r\n"));
        assert!(!check_health(port, T));
    }

    #[test]
    fn servidor_que_cierra_sin_responder() {
        let port = serve_once(|_| Vec::new());
        assert!(!check_health(port, T));
    }

    #[test]
    fn servidor_que_gotea_bytes_respeta_el_plazo_global() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                for _ in 0..40 {
                    if s.write_all(b"H").is_err() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        });
        let started = Instant::now();
        assert!(!check_health(port, Duration::from_millis(300)));
        assert!(started.elapsed() < Duration::from_millis(1000));
    }
}
