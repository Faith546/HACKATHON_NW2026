# Pipeline de Reglas de Negocio: Selección de Mercado

Este documento describe el "pipeline" o flujo de trabajo necesario para definir e implementar **nuevas reglas de negocio (estrategias)** para evaluar y seleccionar al mejor candidato (transportista) durante una campaña.

A medida que el negocio requiera parámetros adicionales (e.g. número de paradas, volumen, tipos de productos) para la selección, se debe seguir este proceso estandarizado.

---

## 1. Modificación del Esquema (Data Layer)

Si la nueva regla requiere nuevos parámetros (e.g. `stops`, `volume`, etc.), agrégalos primero a nivel de base de datos.

1. **Editar** `src/db/schema.ts`. Por ejemplo, agregar a la tabla `operations` o `mandates`:
   ```typescript
   stops: integer("stops").notNull().default(1),
   ```
2. **Actualizar el check de la campaña:** Si agregas una estrategia, debes declararla en la tabla `campaigns` dentro del chequeo `ck_campaigns_strategy`:
   ```typescript
   check("ck_campaigns_strategy", sql`${table.strategy} IN ('LOWEST_VALID_TOTAL', 'BALANCED_SCORE', 'BEST_WEIGHT_PRICE_RATIO', 'TU_NUEVA_ESTRATEGIA')`)
   ```
3. **Generar y aplicar la migración**:
   ```bash
   npm run db:generate
   npm run db:push  # o npm run db:migrate dependiendo del entorno
   ```

## 2. Actualización de Tipos (API Layer)

Asegúrate de que los validadores de la API soporten los nuevos datos y estrategias.

1. **Editar Validadores de Entrada:** En `src/modules/operations/operations.types.ts`, agrega los nuevos parámetros en `CreateOperationSchema`.
2. **Actualizar Estrategias de Mercado:** En `src/modules/market/market.types.ts`:
   ```typescript
   export const marketStrategies = [
     "LOWEST_VALID_TOTAL",
     "BALANCED_SCORE",
     "BEST_WEIGHT_PRICE_RATIO",
     "TU_NUEVA_ESTRATEGIA" // <-- Agregar aquí
   ] as const;
   ```

## 3. Inyección en los Repositorios

Garantiza que la lógica de inserción reconozca los nuevos parámetros.

1. En `operations.repository.ts`, asegúrate de incluir los nuevos campos (ej: `stops: input.stops`) dentro del método `tx.insert(operations)`.
2. En `market.repository.ts`, extrae esos parámetros del registro de la base de datos para utilizarlos durante el ranking. Por ejemplo, pasando `operation.stops` junto a `operation.weightKg` como argumentos a `rankQuotes()`.

## 4. Implementación de la Lógica de Decisión (Business Layer)

Aquí es donde reside el corazón de la regla matemática para elegir al mejor candidato.

1. **Modificar `rankQuotes()` en `market.repository.ts`:**
   Añade un nuevo bloque condicional para tu estrategia, calculando el factor de decisión (e.g., *score de eficiencia = kilos / (precio + penalización por paradas)*).

   ```typescript
   if (strategy === "TU_NUEVA_ESTRATEGIA") {
     const leftScore = calcular(left, weightKg, stops);
     const rightScore = calcular(right, weightKg, stops);
     if (leftScore !== rightScore) {
       return rightScore - leftScore; // El mayor gana
     }
   }
   ```
2. **Actualizar la Explicación (`selectionExplanation()`):**
   Devuelve un string legible describiendo el porqué ganó ese candidato. Esto se utilizará en los eventos de auditoría (`auditEvents`).
   ```typescript
   if (strategy === "TU_NUEVA_ESTRATEGIA") {
      return `Ganó ${winner.quote.id} por maximizar la relación de volumen y peso sobre el precio...`;
   }
   ```

## 5. Pruebas y Validación (QA Layer)

1. **Typechecking:** Corre `npm run typecheck` para asegurar que el sistema de tipos TypeScript esté alineado en todo el flujo.
2. **Pruebas de Integración:** Corre `npm run test`. Si la nueva regla de negocio invalida pruebas anteriores o cambia la estrategia default, ajusta el mock data de las pruebas en `tests/`.

---

**Principio fundamental:** *La Inteligencia Artificial negocia y propone (cotizaciones), pero el motor determinista de Drizzle (este pipeline) decide y audita el veredicto final.*
