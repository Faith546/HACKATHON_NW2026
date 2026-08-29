# Diagrama entidad-relación — SQLite de la demo

Referencia visual del esquema definido en [`02-base-de-datos-sqlite.md`](./02-base-de-datos-sqlite.md).
Los diagramas están en Mermaid: GitHub los renderiza en línea, viajan con el repo y se
versionan como texto plano.

Convenciones de las líneas:

| Símbolo | Significado |
|---|---|
| `\|\|` | exactamente uno |
| `\|o` | cero o uno (columna anulable) |
| `o{` | cero o muchos |
| línea continua | FK declarada en el DDL |
| línea punteada | vínculo lógico **sin** `REFERENCES` (ver §3.4) |

---

## 1. Mapa de dominio — la columna vertebral

Este es el diagrama para las slides y el README: sigue el flujo del negocio
(operación → mandato → campaña → negociación → cotización → compromiso) sin ahogarse en
columnas.

Toda entidad operacional dependiente lleva `operation_id ... ON DELETE CASCADE`: la operación
es la raíz del agregado y borrarla se lleva su historia completa. `carriers` es un catálogo
independiente y no pertenece a una sola operación.

```mermaid
erDiagram
    carriers     |o--o{ operations   : "selected_carrier_id"
    operations   ||--o{ mandates     : "versiones de autoridad"
    operations   ||--o{ campaigns    : "rondas de sourcing"
    campaigns    ||--o{ negotiations : "una por carrier"
    carriers     ||--o{ negotiations : "participa en"
    negotiations ||--o| quotes       : "0..1 cotizacion"
    mandates     ||--o{ quotes       : "mandato evaluado"
    mandates     ||--o{ commitments  : "mandato que autoriza"
    quotes       ||--o{ commitments  : "se cierra en"
    operations   ||--o{ calls        : "llamadas"
    calls        |o--o{ quotes       : "capturada en"
    calls        |o--o{ commitments  : "acuerdo verbal"
    calls        |o--o{ incidents    : "reportado en"
    calls        ||--o{ escalations  : "escalada desde"
    incidents    |o--o{ escalations  : "origina"
    operations   ||--o{ audit_events : "traza"

    campaigns    |o..o| quotes       : "winning_quote_id"
```

Cómo leerlo en voz alta ante los jueces:

> Una operación tiene **muchas versiones de mandato** pero solo una activa. Lanza campañas de
> sourcing; cada campaña abre una negociación por carrier; cada negociación produce **como
> máximo una cotización**; solo una cotización se convierte en compromiso, y solo puede haber
> **un compromiso activo por operación**. Todo lo que pasó por teléfono cuelga de `calls`, y
> todo lo que ocurrió queda en `audit_events`.

---

## 2. Esquema completo

```mermaid
erDiagram
    carriers {
        text id PK
        text name
        text dispatcher_name
        text phone UK "unico"
        text email
        int  score "0-100, default 80"
        int  active "0 o 1"
        text created_at
    }

    operations {
        text id PK
        text customer_name
        text container_number
        text origin
        text destination
        text service "solo DRAYAGE"
        text status "12 estados del ciclo de vida"
        text selected_carrier_id FK "anulable"
        text notes
        text created_at
        text updated_at
    }

    mandates {
        text id PK
        text operation_id FK
        int  version "unico por operacion, mayor o igual a 1"
        text status "ACTIVE o SUPERSEDED"
        int  max_total_price_cents "tope total"
        text currency "MXN"
        text pickup_date "unico dia autorizado"
        text notes
        text created_at
    }

    campaigns {
        text id PK
        text operation_id FK
        text status "QUEUED hasta COMPLETED"
        int  requested_carriers
        int  max_parallel_calls "1 a 3"
        text strategy "LOWEST_VALID_TOTAL o BALANCED_SCORE"
        text winning_quote_id "logico, sin FK"
        text created_at
        text completed_at
    }

    negotiations {
        text id PK
        text operation_id FK
        text campaign_id FK
        text carrier_id FK "unico por campana"
        text status "PENDING hasta SELECTED o REJECTED"
        text latest_offer_json
        text created_at
        text updated_at
    }

    calls {
        text id PK
        text operation_id FK
        text carrier_id FK "anulable"
        text negotiation_id FK "anulable"
        text twilio_call_sid UK "idempotencia del webhook"
        text realtime_session_id
        text direction "INBOUND u OUTBOUND"
        text purpose "modo del agente"
        text status "QUEUED hasta FAILED"
        text from_number
        text to_number
        text transcript_text "unico contenido de la conversacion"
        text brief_json "call brief exigido por el reto"
        text started_at "reloj base de los offsets en ms"
        text ended_at
        text created_at
    }

    quotes {
        text id PK
        text operation_id FK
        text negotiation_id FK "UNIQUE: una quote por negociacion"
        text carrier_id FK
        text call_id FK "anulable"
        int  total_price_cents "precio total informado"
        text currency
        text pickup_date "unico dia"
        text notes
        int  valid "veredicto del Mandate Engine"
        text invalid_reason "por que quedo fuera"
        text mandate_id FK "mandato exacto usado"
        text valid_until
        text created_at
    }

    commitments {
        text id PK
        text operation_id FK
        text quote_id FK
        text carrier_id FK
        text status "PROPOSED hasta FULFILLED"
        text mandate_id FK "mandato que autorizo"
        int  total_price_cents
        text currency
        text pickup_date
        text verbal_agreement_call_id FK
        text confirmed_by "quien dijo que si"
        text exact_terms
        int  evidence_start_ms "offset del transcript"
        int  evidence_end_ms "debe ser mayor que start"
        text evidence_transcript_excerpt
        text summary_channel "SMS o EMAIL"
        text summary_recipient
        text summary_message
        text summary_provider_id
        text summary_sent_at "sin esto no llega a VALID"
        text created_at
        text updated_at
    }

    incidents {
        text id PK
        text operation_id FK
        text call_id FK "anulable"
        text type "etiqueta libre, por ejemplo GENERAL"
        text description
        text reported_by
        text status "OPEN hasta RESOLVED"
        text proposed_change_json
        text evaluation_code "veredicto del Mandate Engine"
        text mandate_id FK "anulable"
        text created_at
        text resolved_at
    }

    escalations {
        text id PK
        text operation_id FK
        text call_id FK "obligatoria: se escala desde una llamada viva"
        text incident_id FK "anulable"
        text reason
        text context_summary "lo que el agente entrega al humano"
        text human_phone
        text twilio_conference_sid
        text status "REQUESTED hasta RESOLVED"
        text created_at
        text resolved_at
    }

    audit_events {
        text id PK
        text operation_id FK
        text event_type
        text actor_type "SYSTEM, agentes, CARRIER, DRIVER"
        text actor_id
        text call_id FK "anulable"
        text entity_type
        text entity_id
        text mandate_id FK "anulable"
        text payload_json
        text occurred_at
    }

    carriers     |o--o{ operations   : "selected_carrier_id"
    carriers     ||--o{ negotiations : "cotiza en"
    carriers     ||--o{ quotes       : "emite"
    carriers     ||--o{ commitments  : "se compromete en"
    carriers     |o--o{ calls        : "atiende"

    operations   ||--o{ mandates     : "versiona"
    operations   ||--o{ campaigns    : "lanza"
    operations   ||--o{ negotiations : "agrupa"
    operations   ||--o{ calls        : "genera"
    operations   ||--o{ quotes       : "recibe"
    operations   ||--o{ commitments  : "cierra"
    operations   ||--o{ incidents    : "sufre"
    operations   ||--o{ escalations  : "escala"
    operations   ||--o{ audit_events : "deja traza"

    campaigns    ||--o{ negotiations : "abre"
    mandates     ||--o{ quotes       : "evalua"
    mandates     ||--o{ commitments  : "autoriza"
    mandates     |o--o{ incidents    : "contextualiza"
    mandates     |o--o{ audit_events : "contextualiza"
    negotiations ||--o| quotes       : "produce"
    negotiations |o--o{ calls        : "se ejecuta por"
    quotes       ||--o{ commitments  : "sustenta"
    calls        |o--o{ quotes       : "captura"
    calls        |o--o{ commitments  : "evidencia verbal"
    calls        |o--o{ incidents    : "reporta"
    calls        ||--o{ escalations  : "origen de"
    calls        |o--o{ audit_events : "contextualiza"
    incidents    |o--o{ escalations  : "provoca"

    campaigns    |o..o| quotes       : "winning_quote_id sin FK"
```

---

## 3. Lo que el diagrama NO puede dibujar

Un ER muestra tablas y FKs. Las garantías que de verdad defienden el sistema ante los jueces
son **índices parciales y CHECKs**, y no aparecen como líneas. Hay que nombrarlas aparte.

### 3.1 Un solo mandato activo por operación

```sql
CREATE UNIQUE INDEX uq_mandates_one_active_per_operation
  ON mandates(operation_id) WHERE status = 'ACTIVE';
```

Los mandatos se **versionan, no se sobrescriben**. Este índice parcial hace imposible que
existan dos autoridades vigentes a la vez. `quotes.mandate_id` y
`commitments.mandate_id` apuntan directamente a la fila inmutable que existía en cada decisión.
El número `version` permanece únicamente en `mandates` y se obtiene con un `JOIN`.

### 3.2 Un solo compromiso activo por operación — el anti-doble-booking

```sql
CREATE UNIQUE INDEX uq_commitments_one_active_per_operation
  ON commitments(operation_id)
  WHERE status IN ('PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED',
                   'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION');
```

Es el índice más importante del esquema. Tres llamadas concurrentes pueden llegar a acuerdo al
mismo tiempo; **la base de datos, no el LLM, garantiza que solo una cierre.** Es
`COMMIT_AUTHORIZED` implementado como restricción física. Los estados cancelados quedan fuera
del filtro, así que tras un `CANCELLED_BY_CARRIER` la operación puede volver a comprometerse.

### 3.3 El precio de la quote siempre es el total

Para mantener la demo simple, `quotes` conserva solamente `total_price_cents`. El agente debe
pedir al carrier un precio total antes de llamar la tool; el Mandate Engine compara ese valor
contra `mandates.max_total_price_cents`. No se desglosan tarifa base, cargos ni condiciones.

### 3.4 Vínculo lógico sin FK declarada

| Columna | Apunta a | Por qué no hay `REFERENCES` |
|---|---|---|
| `campaigns.winning_quote_id` | `quotes.id` | Dependencia circular: la campaña nace antes que las cotizaciones. |

Va punteado en el diagrama. Al no ser FK, un `winning_quote_id` que
apunte a una quote inexistente no lo detiene nadie.

---

## 4. Cómo verlo

- **En GitHub**: se renderiza solo al abrir este archivo. Cero herramientas.
- **En VS Code**: extensión *Markdown Preview Mermaid Support*, luego `Ctrl+Shift+V`.
- **Para exportar a la presentación**: pegar el bloque en <https://mermaid.live> y descargar
  SVG (vectorial, no se pixela en el proyector).
- **Contra la base real**, una vez que exista `data/nextwave-demo.sqlite`: *DB Browser for
  SQLite* o *DBeaver* generan el ER desde el archivo — sirve para verificar que el DDL
  aplicado coincide con este diagrama.
