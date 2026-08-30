# RELAY Evidence Starter

Reference-only module for the future recording/timestamp evidence checkpoint.

## Purpose

Given a finalized transcript turn with trusted start/end timestamps, build a deterministic evidence reference that can later point into the original Twilio recording.

It does **not**:
- start Twilio recording,
- download audio,
- invent timestamps,
- persist anything,
- create commitments.

## Files

- `apps/server/src/evidence/types.ts`
- `apps/server/src/evidence/select-evidence.ts`

## Example

```ts
const evidence = selectEvidenceReference(
  {
    callId: "CA123",
    turnId: "carrier-42",
    speaker: "caller",
    text: "Sí, ocho mil quinientos pesos, todo incluido.",
    final: true,
    startMs: 42000,
    endMs: 45800,
  },
  {
    recordingSid: "RE123",
    durationMs: 120000,
  },
);
```

Result conceptually:

```json
{
  "callId": "CA123",
  "turnId": "carrier-42",
  "excerpt": "Sí, ocho mil quinientos pesos, todo incluido.",
  "evidenceStartMs": 42000,
  "evidenceEndMs": 45800,
  "playbackStartMs": 40000,
  "playbackEndMs": 47300
}
```

The `playback*` range adds padding for a judge-friendly player, while `evidence*` preserves the exact turn window.

## Integration rule

Do not integrate this blindly. Codex should inspect the current `media.ts`, transcript types, CallSid correlation, Twilio media timestamps, and future recording callback shape. Adapt or discard this module if the live repository already has a better equivalent.

The working Realtime voice bridge must remain authoritative.
