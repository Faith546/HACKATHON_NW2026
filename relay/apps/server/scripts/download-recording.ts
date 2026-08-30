import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const recordingSid = process.argv[2];
if (!recordingSid || !/^RE[0-9a-fA-F]{32}$/.test(recordingSid)) {
  throw new Error(
    "Usage: npm run recording:download -- RE0123456789abcdef0123456789abcdef",
  );
}

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
if (!accountSid || !authToken) {
  throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required");
}

const mediaUrl = new URL(
  `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Recordings/${recordingSid}.mp3`,
  "https://api.twilio.com",
);
const authorization = Buffer.from(`${accountSid}:${authToken}`).toString(
  "base64",
);
const response = await fetch(mediaUrl, {
  headers: { Authorization: `Basic ${authorization}` },
});

if (!response.ok) {
  throw new Error(`Twilio recording download failed with HTTP ${response.status}`);
}

const outputDirectory = path.resolve(process.cwd(), ".tmp", "recordings");
await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `${recordingSid}.mp3`);
await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));

console.info(`Recording saved to ${outputPath}`);
