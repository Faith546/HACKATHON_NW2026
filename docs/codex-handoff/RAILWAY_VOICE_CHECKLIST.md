# Railway Voice checklist

No contiene secretos. Confirmar cada punto en Railway antes de una llamada real.

- [ ] El deployment usa el SHA exacto revisado de la branch Voice; anotar SHA y fecha.
- [ ] Root Directory apunta a la raíz de `HACKATHON_NW2026` (donde vive `package.json`).
- [ ] Start Command: `npm run db:migrate && npm start`. Railway no monta volúmenes durante Pre-deploy; la migración SQLite debe ejecutarse al iniciar el contenedor que tiene el volumen.
- [ ] Pre-deploy Command vacío para SQLite en volumen.
- [ ] Antes del merge, resolver `JOINT_BACKEND`: esta branch y `origin/feat/business-rules` contienen migraciones `0002` distintas; no desplegar ambas sin reconciliarlas.
- [ ] `HOST=0.0.0.0`; el código aún usa `127.0.0.1` como default local.
- [ ] `PORT` lo inyecta Railway; el default local es `3000`.
- [ ] Existe volumen persistente para SQLite y `SQLITE_PATH` apunta dentro de ese volumen.
- [ ] `VOICE_RUNTIME_MODE=twilio`.
- [ ] `PUBLIC_BASE_URL=https://<host-http-publico>` sin path adicional.
- [ ] `PUBLIC_WSS_URL=wss://<host-wss-publico>` sin path adicional.
- [ ] Están presentes `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y `TWILIO_PHONE_NUMBER`.
- [ ] Está presente `OPENAI_API_KEY`; revisar también `REALTIME_MODEL` y `REALTIME_VOICE` si se sobrescriben.
- [ ] Health público responde `200`: `GET https://<host>/api/v1/health`.
- [ ] Webhook público inbound: `POST https://<host>/api/v1/webhooks/twilio/voice`.
- [ ] Callback de estado: `POST https://<host>/api/v1/webhooks/twilio/status?callId=<internalCallId>`.
- [ ] Callback de recording: `POST https://<host>/api/v1/webhooks/twilio/recording-status?callId=<internalCallId>`.
- [ ] Media Stream: `wss://<host>/ws/twilio-media/{internalCallId}`.

## Twilio Console

No cambiar Twilio desde Codex. En el número usado para la prueba confirmar:

- INBOUND / “A call comes in”: `POST https://<host>/api/v1/webhooks/twilio/voice`.
- STATUS: `POST https://<host>/api/v1/webhooks/twilio/status` cuando se configure manualmente; las llamadas salientes agregan `callId` automáticamente.
- MEDIA: lo genera el TwiML como `wss://<host>/ws/twilio-media/{internalCallId}`.
- El número ya no debe apuntar al ngrok de Relay para probar Railway.
- Las firmas de Twilio deben validar contra la URL pública exacta, incluido query string en callbacks.

## Evidencia a guardar

Anotar sólo identificadores no secretos: deployment SHA, internalCallId, CallSid, StreamSid, Realtime session id y RecordingSid. No copiar tokens ni credenciales al repositorio.
