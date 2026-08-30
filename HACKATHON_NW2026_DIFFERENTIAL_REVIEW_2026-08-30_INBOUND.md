# Revisión diferencial: último commit e inbound de carriers

## Resumen ejecutivo

| Severidad | Hallazgos |
|---|---:|
| Crítica | 0 |
| Alta | 0 |
| Media | 0 |
| Baja | 1 |

**Commit revisado:** `a945559` contra su primer padre `51cae25`  
**Riesgo global:** bajo para llamadas inbound  
**Recomendación:** aprobar respecto al flujo inbound; el bloqueo observado es comportamiento previo, no una regresión del merge.

## Qué cambió

El merge añadió escalación humana durante llamadas `QUOTE`, configuración de `HUMAN_ESCALATION_PHONE` y pruebas relacionadas. Cambió 7 archivos con 117 adiciones y 2 eliminaciones. No modificó `DrizzleVoiceCoreAdapter.resolveInboundCallContext`, `WebhooksService.receiveVoice` ni las rutas webhook de Twilio.

## Hallazgo

### Baja: carriers no seleccionados pierden contexto inbound al terminar su negociación

**Archivo:** `src/modules/voice/drizzle-voice-core.adapter.ts:243`  
**Introducido antes del último commit:** `99f69db` / `a13557a`  
**Cobertura:** existen pruebas inbound, pero no una prueba específica para el carrier perdedor después de quedar `QUOTED`.

El resolver sólo considera negociaciones `PENDING`, `CALLING`, `NEGOTIATING` o `SELECTED` para el ganador. Cuando una negociación termina como `QUOTED`, un carrier no seleccionado deja de ser candidato. Si llama al número Twilio, el backend responde `INBOUND_CONTEXT_UNRESOLVED` antes de crear el Media Stream.

El carrier ganador sí se resuelve por `operations.selectedCarrierId`. En el estado remoto revisado, `Pacífico` (`+527713494640`) es el ganador y debería entrar en modo `COMMIT`; `Atlas` y `Norte` no tienen contexto inbound vigente después de cerrar sus quotes.

Existe una segunda condición: el teléfono se compara por igualdad exacta contra `Twilio.From`. No hay normalización. Un caller ID oculto, alterno o con formato distinto produce `INBOUND_CALLER_UNKNOWN`.

## Radio de impacto

- Entrada pública: `POST /api/v1/webhooks/twilio/voice`.
- Flujo afectado: llamadas iniciadas por carriers registrados.
- Callers directos e indirectos encontrados para `resolveInboundCallContext`: 10 referencias entre implementación y pruebas.
- No afecta llamadas outbound ni llamadas inbound del operador autorizado.

## Análisis adversarial

Mantener la selección por contexto evita que un teléfono conocido se vincule arbitrariamente a otra operación. Relajarla sin una selección explícita podría mezclar operaciones cuando un carrier participa en varias campañas. Por eso la corrección, si se desea recibir llamadas de carriers perdedores, debe definir un propósito neutral o solicitar un identificador de operación; no debe elegir silenciosamente cualquier operación histórica.

## Cobertura y limitaciones

- Se revisó el 100% del diff del último merge y la ruta inbound de un salto.
- La API remota confirmó carriers, ganador y estado de operación.
- No se pudo consultar Twilio directamente porque las credenciales locales están vacías.
- Confianza alta sobre la lógica backend; confianza media sobre posibles restricciones del carrier telefónico antes de llegar a Twilio.

