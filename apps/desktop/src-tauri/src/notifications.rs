//! Notificaciones del sistema (F2.6). La interfaz web las usa con el plugin oficial `tauri-plugin-notification`
//! por `invoke`; aquí solo se comprueba que la capability de la ventana concede lo mínimo y nada más.

#[cfg(test)]
mod tests {
    use serde_json::Value;

    const CAPABILITY: &str = include_str!("../capabilities/default.json");

    fn permissions() -> Vec<String> {
        let capability: Value = serde_json::from_str(CAPABILITY).expect("capability válida");
        capability["permissions"]
            .as_array()
            .expect("permissions es una lista")
            .iter()
            .map(|p| p.as_str().expect("permiso como texto").to_string())
            .collect()
    }

    #[test]
    fn concede_solo_consultar_pedir_permiso_y_notificar() {
        let mut got = permissions();
        got.sort();
        assert_eq!(
            got,
            [
                "notification:allow-is-permission-granted",
                "notification:allow-notify",
                "notification:allow-request-permission",
            ]
        );
    }

    #[test]
    fn no_usa_conjuntos_amplios_ni_permisos_de_otros_plugins() {
        for permission in permissions() {
            assert!(permission.starts_with("notification:allow-"), "{permission}");
            assert!(!permission.ends_with(":default"), "{permission}");
            for other in ["fs", "shell", "opener", "http", "process", "core:window"] {
                assert!(!permission.contains(other), "{permission}");
            }
        }
    }

    #[test]
    fn la_capability_sigue_limitada_a_la_ventana_principal() {
        let capability: Value = serde_json::from_str(CAPABILITY).expect("capability válida");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
    }
}
