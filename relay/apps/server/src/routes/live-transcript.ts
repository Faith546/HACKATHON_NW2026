import type { FastifyInstance } from "fastify";
import { transcriptBus, type TranscriptTurn } from "../live/transcript.js";

function sseWrite(raw: NodeJS.WritableStream, event: string, payload: unknown) {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function renderViewer(callId: string) {
  const safeCallId = JSON.stringify(callId);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Relay · Live Transcript</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #0b0d10; color: #f5f7fa; }
    main { max-width: 900px; margin: 0 auto; padding: 32px 20px 80px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:24px; }
    h1 { font-size: 22px; margin: 0; }
    .status { font-size: 13px; color:#9ca3af; }
    .status.live::before { content:"●"; color:#22c55e; margin-right:7px; }
    .turn { border:1px solid #232831; background:#12161c; border-radius:14px; padding:14px 16px; margin:10px 0; }
    .meta { font-size:12px; color:#8b95a5; margin-bottom:6px; text-transform:uppercase; letter-spacing:.06em; }
    .text { font-size:16px; line-height:1.45; white-space:pre-wrap; }
    .caller { border-left:3px solid #8b5cf6; }
    .relay { border-left:3px solid #06b6d4; }
    .interrupted { opacity:.72; }
    code { color:#c4b5fd; }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Relay · Live Transcript</h1>
      <div class="status" id="status">connecting…</div>
    </div>
    <code id="call"></code>
  </header>
  <section id="turns"></section>
</main>
<script>
  const callId = ${safeCallId};
  const root = document.getElementById("turns");
  const status = document.getElementById("status");
  document.getElementById("call").textContent = callId;

  function renderTurn(turn) {
    let el = document.getElementById("turn-" + turn.turnId);
    if (!el) {
      el = document.createElement("article");
      el.id = "turn-" + turn.turnId;
      root.appendChild(el);
    }
    el.className = "turn " + turn.speaker + (turn.interrupted ? " interrupted" : "");
    el.innerHTML = "";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent =
      (turn.speaker === "caller" ? "Caller" : "Relay") +
      " · " + (turn.timestampMs / 1000).toFixed(1) + "s" +
      (turn.final ? "" : " · …") +
      (turn.interrupted ? " · interrupted" : "");
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = turn.text;
    el.append(meta, text);
  }

  async function loadSnapshot() {
    const res = await fetch("/api/calls/" + encodeURIComponent(callId) + "/transcript");
    if (!res.ok) return;
    const data = await res.json();
    for (const turn of data.turns ?? []) renderTurn(turn);
  }

  loadSnapshot();

  const es = new EventSource("/api/calls/" + encodeURIComponent(callId) + "/transcript/stream");
  es.addEventListener("open", () => {
    status.textContent = "live";
    status.className = "status live";
  });
  es.addEventListener("turn", (event) => {
    const turn = JSON.parse(event.data);
    renderTurn(turn);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });
  es.onerror = () => {
    status.textContent = "reconnecting…";
    status.className = "status";
  };
</script>
</body>
</html>`;
}

export async function registerLiveTranscriptRoutes(app: FastifyInstance) {
  app.get<{ Params: { callId: string } }>(
    "/api/calls/:callId/transcript",
    async (request) => {
      return {
        callId: request.params.callId,
        turns: transcriptBus.getSnapshot(request.params.callId),
      };
    },
  );

  app.get<{ Params: { callId: string } }>(
    "/api/calls/:callId/transcript/stream",
    async (request, reply) => {
      const { callId } = request.params;

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write("retry: 1500\n\n");

      const onTurn = (turn: TranscriptTurn) => {
        try {
          if (!reply.raw.destroyed) sseWrite(reply.raw, "turn", turn);
        } catch (error) {
          request.log.warn({ error }, "Live transcript SSE write failed");
        }
      };

      transcriptBus.on(`call:${callId}`, onTurn);

      const keepAlive = setInterval(() => {
        reply.raw.write(": keep-alive\n\n");
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(keepAlive);
        transcriptBus.off(`call:${callId}`, onTurn);
      });
    },
  );

  app.get<{ Params: { callId: string } }>(
    "/debug/transcript/:callId",
    async (request, reply) => {
      reply.type("text/html; charset=utf-8");
      return renderViewer(request.params.callId);
    },
  );
}
