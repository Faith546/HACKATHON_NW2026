# Core Modules Documentation

Este documento detalla la lógica de negocio y arquitectura de los módulos implementados en el **Core Plane** del sistema NextWave Voice Logistics.

## 1. Módulo de Transportistas (Carriers)

**Rutas:** `/api/v1/carriers`
**Ubicación:** `src/modules/carriers/`

El módulo de Carriers es el catálogo maestro de proveedores de transporte. Se encarga del clásico CRUD, validando que:
- No existan teléfonos duplicados.
- Se asigne una puntuación (`score`) inicial de 80.
- El transportista esté activo por defecto.

**Arquitectura:**
- **Types (Zod)**: `CreateCarrierSchema` valida que nombre, despachador y teléfono no estén vacíos.
- **Repository**: Utiliza Drizzle ORM para consultas simples.
- **Controller**: Captura el error de restricción única (`UNIQUE constraint failed`) y lanza un `ApiError` oficial (código HTTP 409).

---

## 2. Motor de Mandatos (Operations & Mandates)

**Rutas:** `/api/v1/operations` y `/api/v1/operations/:operationId/mandate`
**Ubicación:** `src/modules/operations/` y `src/modules/mandates/`

El **Mandate Engine** es el corazón transaccional del sistema. Su trabajo es asegurar que cuando se requiere mover un contenedor, existan reglas estrictas y un presupuesto máximo sellado desde el día cero.

**Arquitectura:**
- **Transaccionalidad (Drizzle)**: La creación de una Operación utiliza `db.transaction`. En la misma transacción se ejecutan tres pasos inseparables:
  1. Se crea el registro de la Operación (Estado: `CREATED`).
  2. Se crea la versión 1 del **Mandato** (`ACTIVE`), congelando el presupuesto (`maxTotalPriceCents`) y la moneda (`currency`).
  3. Se emiten dos eventos de auditoría inmutables (`OPERATION_CREATED` y `MANDATE_CREATED`).
- **Control de Versiones (Renegociaciones)**: Si se requiere subir el presupuesto en medio de una operación, se invoca `POST /mandates/versions`. Esto invalida el mandato anterior (`SUPERSEDED`) y levanta la nueva versión.

---

## 3. Orquestador de Mercado (Campaigns & Negotiations)

**Rutas:** `/api/v1/operations/:operationId/campaigns` y `/api/v1/negotiations/:negotiationId`
**Ubicación:** `src/modules/campaigns/` y `src/modules/negotiations/`

Este módulo se encarga de definir la estrategia de licitación y armar la competencia. Aquí no se realizan las llamadas (eso le toca al *Voice Plane*), sino que se prepara la "mesa de negociación".

**Arquitectura:**
- **Campaña**: Agrupa un objetivo comercial. Por ejemplo, "solicito cotizar con 3 transportistas en paralelo buscando el precio más bajo válido".
- **Selección Aleatoria Estratégica**: Al iniciar una campaña, el `CampaignsRepository` selecciona a los transportistas activos ordenados aleatoriamente (`ORDER BY RANDOM()`).
- **Negociaciones Hijas**: Por cada transportista seleccionado, se inserta una `Negotiation` en estado `PENDING`.
- **Auditoría**: Se levanta el evento `CAMPAIGN_QUEUED` indicando cuántos transportistas entraron en la competencia.

---

## 4. Evaluador de Mercado (Market Engine / Quotes)

**Rutas:** `/api/v1/negotiations/:negotiationId/quotes` y `/api/v1/operations/:operationId/market/selection`
**Ubicación:** `src/modules/market/`

Es el módulo matemático y determinista. Recibe la interpretación en lenguaje natural de la IA (Voz) y decide si el sistema debe aceptar la oferta o rechazarla basado estrictamente en el Mandato.

**Arquitectura:**
- **Matemáticas contra Reglas**: Se cruza el precio `totalPriceCents` contra el mandato activo actual. Si el transportista pide más de lo que el mandato permite (o en una moneda errónea), se guarda la cotización como `valid: false` y con un `invalidReason`.
- **Selección de Mercado**: Un endpoint administrativo permite "cerrar el mercado", seleccionando la mejor `Quote` evaluada como válida, marcando la Operación entera como `BOOKED` (adjudicada) e incrustando el ID del transportista seleccionado (`selectedCarrierId`).

---

## 5. Motor de Compromisos (Commitments Engine)

**Rutas:** `/api/v1/operations/:operationId/commitments` y `/api/v1/commitments/:commitmentId/confirm`
**Ubicación:** `src/modules/commitments/`

El Commitments Engine formaliza el "apretón de manos digital". No basta con adjudicar la operación; la IA debe lograr una confirmación verbal (Evidencia).

**Arquitectura:**
- **De Propuesta a Confirmación**: Primero se crea el compromiso (`PROPOSED`) basado en la cotización ganadora. Luego, una vez que la IA finaliza la llamada con un sí del despachador, confirma el compromiso pasando al estado `VALID`.
- **Huella de Evidencia**: Exige guardar el inicio y fin exactos del momento en el audio donde se dio la aceptación (`evidenceStartMs`, `evidenceEndMs`), así como el extracto textual (`evidenceTranscriptExcerpt`). Todo respaldado con el evento de auditoría.
