import twilio from "twilio";

export function createMediaStreamTwiml(input: {
  streamUrl: string;
  callId: string;
}): string {
  const url = new URL(input.streamUrl);
  url.pathname = `/ws/twilio-media/${encodeURIComponent(input.callId)}`;
  url.search = "";
  url.hash = "";
  const response = new twilio.twiml.VoiceResponse();
  const stream = response.connect().stream({ url: url.toString() });
  stream.parameter({ name: "callId", value: input.callId });
  return response.toString();
}
