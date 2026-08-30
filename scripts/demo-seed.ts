import { sqlite } from "../src/db/index";

const carrierId = requiredEnvironment("DEMO_CARRIER_ID");
const carrierPhone = requiredEnvironment("DEMO_CARRIER_PHONE");
if (!/^\+[1-9]\d{7,14}$/.test(carrierPhone)) {
  throw new Error("DEMO_CARRIER_PHONE debe usar formato E.164.");
}
const operationId = process.env.DEMO_OPERATION_ID?.trim() || "op_relay_inbound_demo";
const containerNumber =
  process.env.DEMO_CONTAINER_NUMBER?.trim() || "RELAY-INBOUND-DEMO";
const now = new Date().toISOString();

const seed = sqlite.transaction(() => {
  let carrier = sqlite
    .prepare("SELECT id, phone FROM carriers WHERE id = ?")
    .get(carrierId) as { id: string; phone: string } | undefined;
  if (!carrier) {
    sqlite.prepare(`
      INSERT INTO carriers (
        id, name, dispatcher_name, phone, score, active, created_at
      ) VALUES (?, 'Relay inbound demo', 'Relay demo dispatcher', ?, 90, 1, ?)
    `).run(carrierId, carrierPhone, now);
    carrier = { id: carrierId, phone: carrierPhone };
  } else if (carrier.phone !== carrierPhone) {
    throw new Error(
      `Carrier ${carrierId} ya existe con otro teléfono; no se sobrescribió.`,
    );
  }
  const operatorPhones = new Set(
    (process.env.AUTHORIZED_OPERATOR_PHONES ?? "")
      .split(",")
      .map((phone) => phone.trim())
      .filter(Boolean),
  );
  if (operatorPhones.has(carrier.phone)) {
    throw new Error(
      `El teléfono de ${carrierId} también está en AUTHORIZED_OPERATOR_PHONES; usa identidades distintas antes de probar inbound carrier.`,
    );
  }
  sqlite.prepare("UPDATE carriers SET active = 1 WHERE id = ?").run(carrierId);

  sqlite.prepare(`
    INSERT INTO operations (
      id, customer_name, container_number, origin, destination, service,
      status, selected_carrier_id, weight_kg, notes, created_at, updated_at
    ) VALUES (?, 'Relay inbound demo', ?, 'Manzanillo', 'Guadalajara', 'DRAYAGE',
      'SOURCING', NULL, 10000, 'Seed CLI idempotente para inbound', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'SOURCING', selected_carrier_id = NULL, updated_at = excluded.updated_at
  `).run(operationId, containerNumber, now, now);

  const activeMandate = sqlite
    .prepare("SELECT id FROM mandates WHERE operation_id = ? AND status = 'ACTIVE'")
    .get(operationId) as { id: string } | undefined;
  const mandateId = activeMandate?.id ?? "man_relay_inbound_demo";
  if (activeMandate) {
    sqlite.prepare(`
      UPDATE mandates SET max_total_price_cents = 900000, currency = 'MXN',
        pickup_date = '2026-09-03', notes = 'Relay inbound demo'
      WHERE id = ?
    `).run(mandateId);
  } else {
    sqlite.prepare(`
      INSERT INTO mandates (
        id, operation_id, version, status, max_total_price_cents,
        currency, pickup_date, notes, created_at
      ) VALUES (?, ?, 1, 'ACTIVE', 900000, 'MXN', '2026-09-03',
        'Relay inbound demo', ?)
      ON CONFLICT(id) DO UPDATE SET status = 'ACTIVE'
    `).run(mandateId, operationId, now);
  }

  const campaignId = "cmp_relay_inbound_demo";
  sqlite.prepare(`
    INSERT INTO campaigns (
      id, operation_id, status, requested_carriers, max_parallel_calls,
      strategy, winning_quote_id, created_at, completed_at
    ) VALUES (?, ?, 'COLLECTING_QUOTES', 1, 1, 'LOWEST_VALID_TOTAL', NULL, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET status = 'COLLECTING_QUOTES',
      winning_quote_id = NULL, completed_at = NULL
  `).run(campaignId, operationId, now);

  const existingNegotiation = sqlite
    .prepare("SELECT id FROM negotiations WHERE campaign_id = ? AND carrier_id = ?")
    .get(campaignId, carrierId) as { id: string } | undefined;
  const negotiationId = existingNegotiation?.id ?? "neg_relay_inbound_demo";
  if (existingNegotiation) {
    sqlite.prepare(`
      UPDATE negotiations SET operation_id = ?, status = 'PENDING',
        latest_offer_json = NULL, updated_at = ? WHERE id = ?
    `).run(operationId, now, negotiationId);
  } else {
    sqlite.prepare(`
      INSERT INTO negotiations (
        id, operation_id, campaign_id, carrier_id, status,
        latest_offer_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, ?)
    `).run(negotiationId, operationId, campaignId, carrierId, now, now);
  }

  return { carrierId, carrierPhone: carrier.phone, operationId, mandateId, campaignId, negotiationId };
});

process.stdout.write(`${JSON.stringify(seed(), null, 2)}\n`);
sqlite.close();

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} es obligatorio.`);
  return value;
}
