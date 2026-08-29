# Convenciones compartidas del backend

## Runtime

- `src/app.ts` construye Express y puede importarse desde pruebas sin abrir un puerto.
- `src/server.ts` es el único entrypoint y solamente inicia/cierra el servidor HTTP.
- Todos los endpoints de negocio se montan bajo `/api/v1`.
- `coreRouter` pertenece al workstream de dominio y `voiceRouter` al de voz.

## Respuestas HTTP

Las respuestas exitosas mantienen directamente los modelos definidos en
`openapi.yaml`; no se agrega un wrapper `data`.

Los errores usan siempre:

```json
{
  "code": "RESOURCE_NOT_FOUND",
  "message": "Descripción legible",
  "details": {}
}
```

`details` es opcional. Cada respuesta incluye `x-request-id`. Los códigos base
son `400` para JSON inválido, `404` para rutas inexistentes y `500` para fallos
no controlados. Los módulos deben lanzar `ApiError` para errores esperados.

Los handlers asíncronos deben envolverse con `asyncHandler` para delegar los
errores al middleware común.

## Auditoría

`AuditWriter` crea el ID `evt_`, normaliza el timestamp UTC y garantiza un
payload objeto. La implementación de persistencia se inyecta mediante
`AuditEventRepository`; el adapter Drizzle se añadirá junto con la conexión de
base de datos, sin acoplar el helper compartido al ORM.

## Propiedad de archivos durante el trabajo paralelo

- Core: `src/modules/core` y sus módulos de dominio.
- Voice: `src/modules/voice`, integraciones y runtime de llamadas.
- Integración: `src/app.ts`, `package.json`, `openapi.yaml` y archivos de DB.

Los cambios de contrato o esquema deben coordinarse antes de modificar esos
archivos compartidos.
