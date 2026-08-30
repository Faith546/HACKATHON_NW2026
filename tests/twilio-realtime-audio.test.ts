import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import { requestInitialAgentResponse } from "../src/modules/realtime/twilio-media.bridge";

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  close(): void {
    this.emit("close", {});
  }

  open(): void {
    this.emit("open", {});
  }

  message(data: object): void {
    this.emit("message", { data: JSON.stringify(data) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("Twilio Realtime audio output", () => {
  it("requests an initial response, emits mulaw media, and recovers after barge-in", async () => {
    const twilioSocket = new FakeWebSocket();
    const openAiSocket = new FakeWebSocket();
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: twilioSocket as never,
      createWebSocket: async () => {
        setTimeout(() => openAiSocket.open(), 0);
        return openAiSocket as never;
      },
    });
    twilioSocket.message({
      event: "start",
      streamSid: "MZ_test",
      start: {
        streamSid: "MZ_test",
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8_000,
          channels: 1,
        },
      },
    });

    await transport.connect({
      apiKey: "test",
      model: "gpt-realtime",
      initialSessionConfig: {
        outputModalities: ["audio"],
        audio: {
          input: {
            turnDetection: {
              type: "semantic_vad",
              createResponse: true,
              interruptResponse: true,
            },
          },
          output: { voice: "ash" },
        },
      },
    });
    requestInitialAgentResponse(transport);

    const initialEvents = openAiSocket.sent.map(parseEvent);
    const sessionUpdate = initialEvents.find(
      (event) => event.type === "session.update",
    );
    assert.equal(sessionUpdate?.session.audio.input.format.type, "audio/pcmu");
    assert.equal(sessionUpdate?.session.audio.output.format.type, "audio/pcmu");
    assert.equal(
      sessionUpdate?.session.audio.input.turn_detection.create_response,
      true,
    );
    assert.ok(initialEvents.some((event) => event.type === "response.create"));

    emitAssistantAudio(openAiSocket, "response_1", "item_1");
    assert.equal(twilioEvents(twilioSocket, "media").length, 1);

    twilioSocket.message({
      event: "media",
      streamSid: "MZ_test",
      media: {
        track: "inbound",
        timestamp: "0",
        payload: Buffer.from([0xff, 0xff, 0xff, 0xff]).toString("base64"),
      },
    });
    assert.ok(
      openAiSocket.sent
        .map(parseEvent)
        .some((event) => event.type === "input_audio_buffer.append"),
    );
    openAiSocket.message({
      type: "input_audio_buffer.speech_started",
      event_id: "event_speech_1",
      item_id: "caller_1",
      audio_start_ms: 100,
    });
    assert.equal(twilioEvents(twilioSocket, "clear").length, 1);
    openAiSocket.message({
      type: "response.done",
      event_id: "event_done_1",
      response: { id: "response_1", status: "cancelled", output: [] },
    });
    openAiSocket.message({
      type: "input_audio_buffer.speech_stopped",
      event_id: "event_speech_2",
      item_id: "caller_1",
      audio_end_ms: 600,
    });

    emitAssistantAudio(openAiSocket, "response_2", "item_2");
    assert.equal(twilioEvents(twilioSocket, "media").length, 2);
    transport.close();
  });
});

function emitAssistantAudio(
  socket: FakeWebSocket,
  responseId: string,
  itemId: string,
): void {
  socket.message({
    type: "response.created",
    event_id: `event_${responseId}`,
    response: { id: responseId, status: "in_progress", output: [] },
  });
  socket.message({
    type: "response.output_audio.delta",
    event_id: `event_audio_${responseId}`,
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: Buffer.from([0xff, 0xff, 0xff, 0xff]).toString("base64"),
  });
}

function twilioEvents(socket: FakeWebSocket, type: string): any[] {
  return socket.sent.map(parseEvent).filter((event) => event.event === type);
}

function parseEvent(value: string): any {
  return JSON.parse(value);
}
