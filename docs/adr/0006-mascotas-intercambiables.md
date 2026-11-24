# ADR 0006 — Mascotas intercambiables como paquetes de datos

- Estado: aceptada
- Fecha: 2026-11-24

## Contexto

Queremos una mascota con expresiones que reaccione a lo que hacen los agentes (pensando, esperando
permiso, terminó, error, mareada…). Pero la plataforma debe funcionar sin ella y se debe poder cambiar
de mascota, o hacer una nueva, sin tocar el código de Nexo.

## Decisión

- La mascota es un **paquete de datos**: `companion.json` (validado con zod) + recursos por estado.
  No contiene código ejecutable.
- El núcleo publica eventos neutros; un `CompanionPort` los traduce a estados de mascota. La interfaz
  dibuja el estado actual con los recursos del paquete elegido.
- «Sin mascota» es una opción de primera clase y el valor por defecto hasta que exista la primera.
- Una mascota más compleja (con su propia app o IA) se conecta como cliente externo por MCP/WebSocket.

## Consecuencias

- Cualquiera puede crear una mascota con solo imágenes y un JSON.
- El cargador de paquetes necesita pruebas adversariales: manifiestos malformados, rutas hostiles,
  recursos enormes o que no son imágenes.
