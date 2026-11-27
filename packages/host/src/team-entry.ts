#!/usr/bin/env node
import { EntryError, entryErrorMessage, submitEntryCall, type EntryCall } from "./team-entry-client.js";

const MAX_REQUEST_BYTES = 64 * 1024;

function requestOf(input: unknown): EntryCall {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new EntryError("Invalid entry request: submit one JSON object with an op.");
  const request = input as Record<string, unknown>;
  if (request.op === "post") return { op: "post", entry: request.entry };
  if (request.op === "list") return { op: "list", query: request.query };
  if (request.op === "get") return { op: "get", entryId: request.entryId };
  throw new EntryError("Invalid entry request: op must be post, list, or get.");
}

async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new EntryError("Entry request exceeds 64 KiB.");
    chunks.push(buffer);
  }
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const answer = await submitEntryCall(requestOf(input));
  process.stdout.write(JSON.stringify(answer) + "\n");
}
main().catch((error: unknown) => {
  process.stderr.write(entryErrorMessage(error) + "\n");
  process.exitCode = 1;
});
