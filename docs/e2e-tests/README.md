# Plan maestro de pruebas E2E

Este directorio define los flujos completos que NextWave debe soportar. Los documentos son especificaciones de aceptación: un agente puede convertirlos en pruebas automatizadas, pero no puede cambiar una expectativa para hacer que una implementación defectuosa pase.

## Separación obligatoria

| Suite | Ejecutor | Telefonía o red externa | Propósito |
|---|---|---:|---|
| [`backend-agents`](backend-agents/TEST-BE-00-protocolo.md) | Agentes de IA de prueba | Prohibida | Probar todo el control plane y simular el runtime de voz con fakes. |
| [`voice-manual`](voice-manual/TEST-VOICE-00-preparacion.md) | Persona responsable de la demo | Requerida y autorizada | Validar Twilio, PSTN, OpenAI Realtime, audio, SMS y conferencia humana reales. |

Un agente automatizado nunca debe ejecutar un archivo `TEST-VOICE-*`, marcar números reales ni enviar SMS reales. La presencia de credenciales no constituye autorización.

## Fuente de verdad

Las expectativas funcionales se derivan, en este orden, de:

1. `openapi.yaml`, como contrato HTTP objetivo.
2. Las máquinas de estado descritas en `docs/01-arquitectura-y-flujos-api.md` y las restricciones de `src/db/schema.ts`.
3. Los ports `VoiceCorePort`, `CallScheduler`, `TelephonyGateway` y `SummarySender`.
4. Estos casos E2E, que fijan los ejemplos y criterios de aceptación.

Si la implementación actual difiere del contrato, el resultado correcto es `FAIL` o `BLOCKED`; no se acepta una respuesta alternativa sin actualizar primero el contrato y esta especificación de forma deliberada.

## Datos canónicos de prueba

Todos los flujos usan datos nuevos por ejecución. Los sufijos deben incluir un identificador único para evitar colisiones.

```text
Reloj controlado T0: 2026-09-01T12:00:00.000Z
Cliente: Textiles Pacífico E2E-<runId>
Contenedor: 1234
Origen: Puerto de Manzanillo
Destino: Guadalajara
Servicio: DRAYAGE
Pickup autorizado: 2026-09-03
Precio máximo: 9,000 MXN
```

| Simulador | Oferta final | Resultado determinista |
|---|---:|---|
| Carrier A — Atlas | 8,500 MXN, 2026-09-03 | Válida y ganadora. |
| Carrier B — Norte | 9,300 MXN, 2026-09-03 | Inválida por precio. |
| Carrier C — Pacífico | 8,800 MXN, 2026-09-03 | Válida, pero no ganadora. |

El `runId` se conserva en el cliente/notas, no se agrega al número de contenedor. Los números de la suite backend son datos ficticios (`+525500000001` a `+525500000003`) y nunca deben salir a la red. En la suite manual se sustituyen por números de personas que dieron consentimiento.

## Significado de una respuesta correcta

Cada paso debe comprobar cinco capas:

1. Código HTTP o resultado de service exacto.
2. Campos semánticos obligatorios; los identificadores y timestamps dinámicos se validan por tipo y relación, no por valor literal.
3. Estado persistido después de la acción.
4. Eventos de auditoría y ausencia de eventos duplicados.
5. Ausencia de efectos laterales no autorizados, especialmente llamadas, SMS, cambios de mandato y commitments adicionales.

La respuesta de error común debe conservar esta forma:

```json
{
  "code": "CODIGO_ESTABLE",
  "message": "Mensaje legible",
  "details": {}
}
```

`details` puede omitirse. Toda respuesta HTTP debe incluir `x-request-id`; el valor debe ser no vacío y estable dentro de la misma solicitud.

## Estados del resultado

| Resultado | Uso |
|---|---|
| `PASS` | Todas las aserciones obligatorias se cumplieron y existe evidencia. |
| `FAIL` | El sistema respondió, pero alguna aserción no se cumplió. |
| `BLOCKED` | Una precondición externa o un vertical slice todavía inexistente impide llegar al paso. |
| `SKIPPED` | Solo se admite cuando el propio documento declara el paso opcional. |

No se permite convertir un `404 ROUTE_NOT_FOUND`, un `501`, un `503` o una excepción en `PASS` porque el componente esté pendiente.

## Orden recomendado

### Agentes, sin llamadas

1. [`TEST-BE-00-protocolo.md`](backend-agents/TEST-BE-00-protocolo.md)
2. [`TEST-BE-01-sourcing-y-commitment.md`](backend-agents/TEST-BE-01-sourcing-y-commitment.md)
3. [`TEST-BE-02-realtime-sin-audio.md`](backend-agents/TEST-BE-02-realtime-sin-audio.md)
4. [`TEST-BE-03-guardrails-e-idempotencia.md`](backend-agents/TEST-BE-03-guardrails-e-idempotencia.md)
5. [`TEST-BE-04-incidentes-escalacion-y-ejecucion.md`](backend-agents/TEST-BE-04-incidentes-escalacion-y-ejecucion.md)

### Persona, con voz y llamadas reales

1. [`TEST-VOICE-00-preparacion.md`](voice-manual/TEST-VOICE-00-preparacion.md)
2. [`TEST-VOICE-01-outbound-negociacion-y-commitment.md`](voice-manual/TEST-VOICE-01-outbound-negociacion-y-commitment.md)
3. [`TEST-VOICE-02-inbound-incidente-y-ejecucion.md`](voice-manual/TEST-VOICE-02-inbound-incidente-y-ejecucion.md)
4. [`TEST-VOICE-03-calidad-y-fallos.md`](voice-manual/TEST-VOICE-03-calidad-y-fallos.md)

## Criterio global de aceptación

La demo solo se considera E2E completa cuando:

- los cinco casos backend terminan en `PASS` sin red externa;
- los cuatro casos manuales terminan en `PASS` con evidencia de Twilio y del backend;
- se contactan tres carriers, se comparan tres resultados y solo uno queda autorizado;
- ningún modelo cambia directamente un mandato, el ganador o un commitment;
- el commitment solo llega a `VALID` después de acuerdo explícito, evidencia y recap aceptado;
- incidencias fuera del mandato se escalan, y pickup/delivery respetan la máquina de estados;
- la línea de tiempo permite reconstruir cada decisión sin grabaciones de audio.

## Formato del reporte de ejecución

Cada ejecutor debe entregar un reporte con esta forma:

```markdown
# Resultado <TEST-ID>

- Commit probado: <sha>
- Run ID: <id>
- Ejecutor: <agente o persona>
- Inicio/fin: <timestamps>
- Resultado global: PASS | FAIL | BLOCKED
- Acceso externo observado: ninguno | detalle autorizado

| Paso | Esperado | Observado | Evidencia | Resultado |
|---|---|---|---|---|
| 1 | ... | ... | log/response/id | PASS |

## Defectos

- Severidad, paso, reproducción y diferencia exacta.
```

Nunca deben copiarse secretos, tokens de Twilio/OpenAI ni números personales completos al reporte.
