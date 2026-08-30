# Decision Log — CyberChipmunk

NextWave Hackathon 2026 · Mexico City

## 1. Asynchronous job and queue management  `T+17:35`

**Options considered**

- Redis + BullMQ / Celery
- Message Brokers (Kafka, RabbitMQ, NATS)
- Node.js native in-memory queue

**Chosen:** Node.js

**Why:** It avoids setting up additional infrastructure for the Hackathon MVP. The trade-off is consciously accepted: if the Node.js process restarts or crashes, any pending jobs in the queue are lost, as the queue is not rebuilt from the database.

## 2. Storage of verbal agreement evidence (Recordings vs Transcripts)  `T+17:36`

**Options considered**

- Store full audio files (Blobs in S3 or local)
- Store signed URLs to Twilio recordings
- Store only text transcript excerpts with time offsets (milliseconds)

**Chosen:** Store only a transcript excerpt along with its start and end offsets

**Why:** It drastically reduces storage requirements and the complexity of handling binary media files. The trade-off is that the exact audio cannot be played back directly from the DB (slightly reducing strict audit compliance), assuming that the text is sufficient evidence for the demo.

## 3. Schema for storing variable structured data (e.g., call briefs, offers)  `T+17:37`

**Options considered**

- Fully normalized relational tables
- Native JSON stored in databases like Postgres
- Serialized JSON strings in plain text columns

**Chosen:** Serialized JSON in TEXT columns

**Why:** Given that SQLite was chosen (which handles JSON via additional functions on text columns), saving variable payloads as JSON strings provides extreme flexibility for rapidly iterating on the data extracted by the LLM. Strict structural validation at the database level is sacrificed in exchange for development speed.
