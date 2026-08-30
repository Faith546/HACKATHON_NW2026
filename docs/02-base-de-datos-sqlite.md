# Diseño de base de datos SQLite

## 1. Objetivo

Este documento define exclusivamente la persistencia SQLite necesaria para la demo funcional. El modelo prioriza simplicidad, trazabilidad y facilidad de inspección por encima de escalabilidad o seguridad de producción.

Archivo recomendado:

```text
data/nextwave-demo.sqlite
```

## 2. Decisiones de simplificación

- Una sola base SQLite local.
- Una sola instancia del backend escribe en ella.
- No hay tablas de usuarios, roles, permisos o sesiones autenticadas.
- No hay tabla de jobs: la cola existe únicamente en memoria de Node.js.
- No hay tabla de eventos distribuidos ni outbox.
- No hay tabla separada de transcripts o call briefs: se guardan en `calls`.
- No hay tabla separada de evidencia: el commitment guarda offsets y un fragmento del transcript.
- No hay tabla separada de notificaciones: el recap se guarda en `commitments`.
- No se almacenan grabaciones, URLs de grabación ni blobs de audio.
- Los objetos variables se guardan como JSON serializado en columnas `TEXT`.

Estas decisiones son apropiadas para una demo, pero no para un sistema distribuido o regulado.

## 3. Configuración recomendada

Al abrir la conexión:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

- `foreign_keys` aplica integridad referencial.
- `WAL` permite lecturas mientras hay una escritura.
- `busy_timeout` reduce errores cuando terminan varias llamadas casi simultáneamente.
- `synchronous=NORMAL` es un equilibrio suficiente para la demo.

La librería sugerida es `better-sqlite3` porque su API síncrona simplifica las transacciones y es suficiente para este volumen.

## 4. Convenciones

### Identificadores

Todos los IDs son `TEXT` generados por la aplicación:

```text
car_...   carrier
op_...    operation
man_...   mandate
cmp_...   campaign
neg_...   negotiation
call_...  call
quo_...   quote
com_...   commitment
inc_...   incident
esc_...   escalation
aud_...   audit event
```

Puede usarse `crypto.randomUUID()` con el prefijo correspondiente.

### Fechas

- Instantes: ISO 8601 UTC en `TEXT`, por ejemplo `2026-09-03T16:00:00.000Z`.
- La única fecha del mandato usa `YYYY-MM-DD`; no existe hora inicial o final.

### Dinero

SQLite almacena dinero como centavos enteros:

```text
$9,000.00 MXN → 900000
```

La API recibe y devuelve unidades monetarias como `9000`; el repository convierte entre unidades y centavos. Esto evita errores de punto flotante.

### Booleanos

Se almacenan como `INTEGER` con valores `0` y `1`.

### JSON

Las columnas terminadas en `_json` contienen JSON serializado. La aplicación valida su estructura antes de insertarlo.

## 5. Relación entre tablas

```text
carriers
   │
   ├──────────────┐
   ▼              ▼
operations     negotiations ◄──── campaigns
   │              │   │
   ├─ mandates    │   ├─ calls
   │              │   └─ quotes
   │              │
   ├──────────────┴──── commitments
   │
   ├─ incidents ───── escalations
   │
   └─ audit_events
```

## 6. Tablas necesarias

### 6.1 `carriers`

Directorio mínimo de transportistas y contactos telefónicos.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Identidad interna. |
| `name` | TEXT | Razón social o nombre de demo. |
| `dispatcher_name` | TEXT | Contacto principal. |
| `phone` | TEXT UNIQUE | Número utilizado para llamadas. |
| `email` | TEXT | Recap por correo si aplica. |
| `score` | INTEGER | Desempate simple de 0 a 100. |
| `active` | INTEGER | Permite excluir carriers. |
| `created_at` | TEXT | Auditoría básica. |

### 6.2 `operations`

Entidad raíz del proceso logístico.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Operación. |
| `customer_name` | TEXT | Textiles Pacífico. |
| `container_number` | TEXT | Contenedor. |
| `origin` | TEXT | Puerto de origen. |
| `destination` | TEXT | Destino. |
| `service` | TEXT | `DRAYAGE`. |
| `status` | TEXT | Estado operacional. |
| `selected_carrier_id` | TEXT FK | Carrier ganador, si existe. |
| `notes` | TEXT | Información libre de la demo. |
| `created_at`, `updated_at` | TEXT | Timestamps. |

### 6.3 `mandates`

Cada fila es una versión inmutable de la autoridad operacional.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | ID de la versión. |
| `operation_id` | TEXT FK | Operación. |
| `version` | INTEGER | 1, 2, 3… |
| `status` | TEXT | `ACTIVE` o `SUPERSEDED`. |
| `max_total_price_cents` | INTEGER | Límite total. |
| `currency` | TEXT | `MXN`. |
| `pickup_date` | TEXT | Único día autorizado. |
| `notes` | TEXT | Contexto libre; no crea reglas deterministas. |
| `created_at` | TEXT | Momento de autorización. |

La columna `version` existe únicamente en esta tabla. `quotes`, `commitments`, `incidents` y `audit_events` conservan una FK `mandate_id → mandates.id`; nunca copian el número de versión. La versión se obtiene mediante `JOIN` cuando se necesita mostrarla.

### 6.4 `campaigns`

Representa un intento de sourcing. Permite una campaña inicial y otra posterior si el carrier cancela.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Campaña. |
| `operation_id` | TEXT FK | Operación. |
| `status` | TEXT | Progreso. |
| `requested_carriers` | INTEGER | Debe ser al menos 3 para la demo principal. |
| `max_parallel_calls` | INTEGER | Máximo 3. |
| `strategy` | TEXT | Estrategia de selección. |
| `winning_quote_id` | TEXT | Se llena al seleccionar. |
| `created_at`, `completed_at` | TEXT | Timestamps. |

### 6.5 `negotiations`

Una fila por combinación campaña-carrier.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Negociación. |
| `operation_id` | TEXT FK | Consulta directa. |
| `campaign_id` | TEXT FK | Campaña. |
| `carrier_id` | TEXT FK | Carrier. |
| `status` | TEXT | Estado de negociación. |
| `latest_offer_json` | TEXT | Última oferta interpretada. |
| `created_at`, `updated_at` | TEXT | Timestamps. |

La combinación `(campaign_id, carrier_id)` es única.

### 6.6 `calls`

Registra llamadas entrantes y salientes, su correlación y resultado post-call.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | ID interno. |
| `operation_id` | TEXT FK | Operación. |
| `carrier_id` | TEXT FK nullable | Actor externo. |
| `negotiation_id` | TEXT FK nullable | Negociación. |
| `twilio_call_sid` | TEXT UNIQUE | ID idempotente de Twilio. |
| `realtime_session_id` | TEXT | Correlación temporal. |
| `direction` | TEXT | `INBOUND` o `OUTBOUND`. |
| `purpose` | TEXT | `QUOTE`, `COMMIT`, `INCIDENT`, etc. |
| `status` | TEXT | Lifecycle de la llamada. |
| `from_number`, `to_number` | TEXT | Números telefónicos. |
| `transcript_text` | TEXT | Único contenido persistido de la conversación. |
| `brief_json` | TEXT | Call brief estructurado. |
| `started_at`, `ended_at`, `created_at` | TEXT | Timestamps. |

No se crea una tabla `realtime_sessions`: el contexto de sesión es efímero y puede mantenerse en memoria; `calls.realtime_session_id` basta para correlación durante la demo.

### 6.7 `quotes`

Cotización final estructurada de una negociación.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Quote. |
| `operation_id` | TEXT FK | Operación. |
| `negotiation_id` | TEXT FK | Negociación. |
| `carrier_id` | TEXT FK | Carrier. |
| `call_id` | TEXT FK | Evidencia conversacional. |
| `total_price_cents` | INTEGER | Precio total informado y evaluado. |
| `currency` | TEXT | Moneda. |
| `pickup_date` | TEXT | Día ofrecido. |
| `notes` | TEXT | Contexto libre de la cotización. |
| `valid` | INTEGER | Cumplía el mandato al registrarse. |
| `invalid_reason` | TEXT | Causa de invalidez. |
| `mandate_id` | TEXT FK | Mandato exacto usado para evaluar. |
| `valid_until` | TEXT | Expiración. |
| `created_at` | TEXT | Recepción. |

### 6.8 `commitments`

Acuerdo oficial y verificable con el carrier ganador.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Commitment. |
| `operation_id` | TEXT FK | Operación. |
| `quote_id` | TEXT FK | Oferta ganadora. |
| `carrier_id` | TEXT FK | Carrier comprometido. |
| `status` | TEXT | Máquina de estados. |
| `mandate_id` | TEXT FK | Mandato exacto que autorizó el acuerdo. |
| `total_price_cents` | INTEGER | Copia inmutable del precio. |
| `currency` | TEXT | Moneda. |
| `pickup_date` | TEXT | Día comprometido. |
| `verbal_agreement_call_id` | TEXT FK | Llamada de confirmación. |
| `confirmed_by` | TEXT | Persona que dijo sí. |
| `exact_terms` | TEXT | Recap verbal. |
| `evidence_start_ms`, `evidence_end_ms` | INTEGER | Intervalo exacto. |
| `evidence_transcript_excerpt` | TEXT | Fragmento confirmado del transcript. |
| `summary_channel` | TEXT | SMS o EMAIL. |
| `summary_recipient`, `summary_message` | TEXT | Recap. |
| `summary_provider_id` | TEXT | SID/id del proveedor. |
| `summary_sent_at` | TEXT | Confirmación de envío. |
| `created_at`, `updated_at` | TEXT | Timestamps. |

Un índice parcial impide más de un commitment activo por operación.

### 6.9 `incidents`

Problemas reportados durante ejecución.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Incidencia. |
| `operation_id` | TEXT FK | Operación. |
| `call_id` | TEXT FK | Llamada que la originó. |
| `type` | TEXT | Etiqueta libre y amplia, por ejemplo `GENERAL`. |
| `description` | TEXT | Descripción interpretada. |
| `reported_by` | TEXT | Persona. |
| `status` | TEXT | Resolución. |
| `proposed_change_json` | TEXT | Cambio solicitado. |
| `evaluation_code` | TEXT | Resultado del Mandate Engine. |
| `mandate_id` | TEXT FK nullable | Mandato usado para evaluar la incidencia. |
| `created_at`, `resolved_at` | TEXT | Timestamps. |

### 6.10 `escalations`

Registra la incorporación de un humano a una llamada.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Escalación. |
| `operation_id` | TEXT FK | Operación. |
| `call_id` | TEXT FK | Llamada activa. |
| `incident_id` | TEXT FK nullable | Incidencia relacionada. |
| `reason` | TEXT | Motivo. |
| `context_summary` | TEXT | Handoff al humano. |
| `human_phone` | TEXT | Número agregado. |
| `twilio_conference_sid` | TEXT | Conferencia. |
| `status` | TEXT | Progreso. |
| `created_at`, `resolved_at` | TEXT | Timestamps. |

### 6.11 `audit_events`

Timeline append-only de decisiones y acciones.

| Columna | Tipo | Uso |
|---|---|---|
| `id` | TEXT PK | Evento. |
| `operation_id` | TEXT FK | Operación. |
| `event_type` | TEXT | Tipo de evento. |
| `actor_type`, `actor_id` | TEXT | Quién actuó. |
| `call_id` | TEXT FK nullable | Llamada relacionada. |
| `entity_type`, `entity_id` | TEXT | Entidad afectada. |
| `mandate_id` | TEXT FK nullable | Mandato relacionado con el evento. |
| `payload_json` | TEXT | Datos relevantes. |
| `occurred_at` | TEXT | Timestamp. |

Para la demo no se implementa prevención de UPDATE o DELETE, pero los repositories deben tratar esta tabla como append-only.

## 7. DDL completo propuesto

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

CREATE TABLE carriers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dispatcher_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  score INTEGER NOT NULL DEFAULT 80 CHECK (score BETWEEN 0 AND 100),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  container_number TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT 'DRAYAGE' CHECK (service = 'DRAYAGE'),
  status TEXT NOT NULL CHECK (status IN (
    'CREATED', 'SOURCING', 'BOOKED', 'PICKUP_PENDING',
    'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED',
    'NEEDS_RENEGOTIATION', 'ESCALATED', 'NEEDS_CARRIER', 'CANCELLED'
  )),
  selected_carrier_id TEXT REFERENCES carriers(id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mandates (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  max_total_price_cents INTEGER NOT NULL CHECK (max_total_price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'MXN',
  pickup_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (operation_id, version)
);

CREATE UNIQUE INDEX uq_mandates_one_active_per_operation
  ON mandates(operation_id)
  WHERE status = 'ACTIVE';

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'CALLING', 'COLLECTING_QUOTES',
    'READY_TO_SELECT', 'COMPLETED', 'FAILED'
  )),
  requested_carriers INTEGER NOT NULL CHECK (requested_carriers >= 1),
  max_parallel_calls INTEGER NOT NULL DEFAULT 3
    CHECK (max_parallel_calls BETWEEN 1 AND 3),
  strategy TEXT NOT NULL DEFAULT 'LOWEST_VALID_TOTAL'
    CHECK (strategy IN ('LOWEST_VALID_TOTAL', 'BALANCED_SCORE')),
  winning_quote_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE negotiations (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  carrier_id TEXT NOT NULL REFERENCES carriers(id),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'CALLING', 'NEGOTIATING', 'QUOTED',
    'REFUSED', 'NO_ANSWER', 'SELECTED', 'REJECTED'
  )),
  latest_offer_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, carrier_id)
);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  carrier_id TEXT REFERENCES carriers(id),
  negotiation_id TEXT REFERENCES negotiations(id),
  twilio_call_sid TEXT UNIQUE,
  realtime_session_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'OPERATIONS', 'QUOTE', 'COMMIT', 'EXECUTION',
    'INCIDENT', 'DELIVERY', 'RENEGOTIATION', 'ESCALATION'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED',
    'BUSY', 'NO_ANSWER', 'FAILED'
  )),
  from_number TEXT,
  to_number TEXT,
  transcript_text TEXT,
  brief_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  negotiation_id TEXT NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  carrier_id TEXT NOT NULL REFERENCES carriers(id),
  call_id TEXT REFERENCES calls(id),
  total_price_cents INTEGER NOT NULL CHECK (total_price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'MXN',
  pickup_date TEXT NOT NULL,
  notes TEXT,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  invalid_reason TEXT,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  valid_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (negotiation_id)
);

CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  carrier_id TEXT NOT NULL REFERENCES carriers(id),
  status TEXT NOT NULL CHECK (status IN (
    'PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED',
    'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION',
    'FULFILLED', 'CANCELLED_BY_CARRIER', 'CANCELLED'
  )),
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  total_price_cents INTEGER NOT NULL CHECK (total_price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'MXN',
  pickup_date TEXT NOT NULL,
  verbal_agreement_call_id TEXT REFERENCES calls(id),
  confirmed_by TEXT,
  exact_terms TEXT,
  evidence_start_ms INTEGER CHECK (evidence_start_ms IS NULL OR evidence_start_ms >= 0),
  evidence_end_ms INTEGER CHECK (evidence_end_ms IS NULL OR evidence_end_ms > 0),
  evidence_transcript_excerpt TEXT,
  summary_channel TEXT CHECK (summary_channel IS NULL OR summary_channel IN ('SMS', 'EMAIL')),
  summary_recipient TEXT,
  summary_message TEXT,
  summary_provider_id TEXT,
  summary_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    evidence_end_ms IS NULL OR evidence_start_ms IS NULL
    OR evidence_end_ms > evidence_start_ms
  )
);

CREATE UNIQUE INDEX uq_commitments_one_active_per_operation
  ON commitments(operation_id)
  WHERE status IN (
    'PROPOSED', 'VERBALLY_AGREED', 'MANDATE_VALIDATED',
    'SUMMARY_PENDING', 'SUMMARY_SENT', 'VALID', 'IN_EXECUTION'
  );

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  call_id TEXT REFERENCES calls(id),
  type TEXT NOT NULL DEFAULT 'GENERAL',
  description TEXT NOT NULL,
  reported_by TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'OPEN', 'ALLOWED_CHANGE', 'NEEDS_ESCALATION', 'RESOLVED'
  )),
  proposed_change_json TEXT,
  evaluation_code TEXT,
  mandate_id TEXT REFERENCES mandates(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE escalations (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL REFERENCES calls(id),
  incident_id TEXT REFERENCES incidents(id),
  reason TEXT NOT NULL,
  context_summary TEXT NOT NULL,
  human_phone TEXT,
  twilio_conference_sid TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'REQUESTED', 'DIALING_HUMAN', 'HUMAN_JOINED', 'RESOLVED', 'FAILED'
  )),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'SYSTEM', 'INTERNAL_OPERATOR', 'OPERATIONS_AGENT',
    'LOGISTICS_AGENT', 'CARRIER', 'DRIVER'
  )),
  actor_id TEXT,
  call_id TEXT REFERENCES calls(id),
  entity_type TEXT,
  entity_id TEXT,
  mandate_id TEXT REFERENCES mandates(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_operations_status
  ON operations(status);

CREATE INDEX idx_operations_container
  ON operations(container_number);

CREATE INDEX idx_campaigns_operation
  ON campaigns(operation_id, created_at DESC);

CREATE INDEX idx_negotiations_operation_status
  ON negotiations(operation_id, status);

CREATE INDEX idx_calls_operation_created
  ON calls(operation_id, created_at DESC);

CREATE INDEX idx_calls_carrier_status
  ON calls(carrier_id, status);

CREATE INDEX idx_quotes_operation_valid_price
  ON quotes(operation_id, valid, total_price_cents);

CREATE INDEX idx_incidents_operation_status
  ON incidents(operation_id, status);

CREATE INDEX idx_audit_operation_time
  ON audit_events(operation_id, occurred_at);
```

## 8. Ajuste de la referencia al ganador

`campaigns.winning_quote_id` no declara foreign key dentro del DDL inicial porque `quotes` se crea después. Para mantener el script simple hay dos opciones:

1. Conservarlo como `TEXT` y validarlo desde el Market Service, opción recomendada para la demo.
2. Crear `campaigns` después de `quotes`, lo que complica la dependencia con `negotiations`.

La primera opción evita una referencia circular en el orden de creación y sigue siendo suficiente para este alcance.

## 9. Transacciones obligatorias

Aunque sea una demo, cinco operaciones deben ser atómicas.

### 9.1 Crear operación y mandato inicial

El `POST /operations` ejecuta dentro de una transacción:

1. Insertar `operations` con estado `CREATED`.
2. Insertar `mandates` versión `1` y estado `ACTIVE`.
3. Insertar `OPERATION_CREATED` y `MANDATE_CREATED` en `audit_events` con el nuevo `mandate_id`.

Si falla cualquiera de los pasos, no se conserva una operación sin mandato.

### 9.2 Crear una nueva versión de mandato

Dentro de una transacción:

1. Leer la versión activa.
2. Marcarla `SUPERSEDED`.
3. Insertar la nueva versión `ACTIVE`.
4. Insertar `MANDATE_UPDATED` en `audit_events` con el nuevo `mandate_id`.

El índice parcial evita dos versiones activas.

### 9.3 Registrar una quote

Dentro de una transacción:

1. Normalizar el precio total a centavos.
2. Evaluar el mandato.
3. Insertar `quotes`.
4. Actualizar `negotiations.status = 'QUOTED'`.
5. Insertar `QUOTE_RECORDED`.

### 9.4 Autorizar un commitment

Usar `BEGIN IMMEDIATE` para reservar el único writer:

1. Confirmar que la quote es la ganadora, válida y no expirada.
2. Confirmar el mandato vigente.
3. Confirmar que no existe otro commitment activo.
4. Insertar el commitment `PROPOSED`.
5. Actualizar carrier y negociación seleccionados.
6. Insertar `COMMIT_AUTHORIZED`.
7. Commit.

El índice `uq_commitments_one_active_per_operation` funciona como segunda defensa contra double booking.

### 9.5 Confirmar pickup o delivery

Dentro de la misma transacción se actualizan:

- `operations.status`.
- `commitments.status`.
- `audit_events`.

## 10. Consultas principales

### Cotizaciones válidas para selección

```sql
SELECT
  q.*,
  c.name AS carrier_name,
  c.score AS carrier_score
FROM quotes q
JOIN carriers c ON c.id = q.carrier_id
WHERE q.operation_id = ?
  AND q.valid = 1
  AND q.valid_until > ?
ORDER BY q.total_price_cents ASC,
         c.score DESC,
         q.created_at ASC;
```

### Mandato activo

```sql
SELECT *
FROM mandates
WHERE operation_id = ?
  AND status = 'ACTIVE'
LIMIT 1;
```

### Resolver una llamada entrante por carrier

```sql
SELECT DISTINCT
  o.id,
  o.container_number,
  o.origin,
  o.destination,
  o.status
FROM carriers c
JOIN negotiations n ON n.carrier_id = c.id
JOIN operations o ON o.id = n.operation_id
WHERE c.phone = ?
  AND o.status NOT IN ('COMPLETED', 'CANCELLED');
```

Si devuelve más de una operación, el agente debe pedir el contenedor o la ruta.

### Timeline auditable

```sql
SELECT *
FROM audit_events
WHERE operation_id = ?
ORDER BY occurred_at ASC, id ASC;
```

## 11. Datos seed recomendados

La demo debe iniciar con tres carriers:

```sql
INSERT INTO carriers
  (id, name, dispatcher_name, phone, email, score, active, created_at)
VALUES
  ('car_atlas', 'Transportes Atlas', 'Laura', '+525555555501', 'atlas@example.test', 88, 1, CURRENT_TIMESTAMP),
  ('car_norte', 'Carga Norte', 'Miguel', '+525555555502', 'norte@example.test', 82, 1, CURRENT_TIMESTAMP),
  ('car_pacifico', 'Fletes Pacífico', 'Sofía', '+525555555503', 'pacifico@example.test', 91, 1, CURRENT_TIMESTAMP);
```

Antes de la demo deben sustituirse los números ficticios por teléfonos controlados por el equipo o jueces.

## 12. Componentes de persistencia en el código

Solo son necesarios:

```text
database/
├── sqlite.js             abre una conexión singleton y aplica PRAGMAs
├── migrate.js            ejecuta migraciones pendientes
├── migrations/
│   └── 001_initial.sql   DDL de este documento
└── seed.js               agrega carriers de demo

*/repositories/
└── *.repository.js       SQL preparado por módulo
```

No se necesita ORM para este tamaño. Queries preparadas y repositories explícitos hacen más visible la lógica que debe defenderse ante los jueces.

## 13. Backup y reset de demo

Antes de presentar:

1. Con el proceso detenido, copiar `data/nextwave-demo.sqlite` como plantilla.
2. Para reiniciar el escenario, reemplazar la base activa con la copia limpia.
3. No borrar el archivo mientras Express mantiene la conexión abierta.

También puede existir un script local `npm run demo:reset` que cierre la aplicación, copie la plantilla y vuelva a iniciar. No es necesario exponer un endpoint destructivo de reset.

## 14. Límites conocidos

- SQLite solo permite un writer a la vez.
- La cola en memoria no se reconstruye desde la base.
- No hay cifrado de datos ni control de acceso.
- Los JSON en `TEXT` no tienen validación estructural de base de datos.
- Sin grabación no existe evidencia de audio reproducible; solo transcript y offsets temporales.
- Una sola instancia del backend es una condición del diseño.

Para las tres llamadas concurrentes de la demo, WAL, transacciones cortas y `busy_timeout=5000` son suficientes. Si el sistema evolucionara a producción, las primeras migraciones serían PostgreSQL, una cola persistente y almacenamiento de objetos controlado.
