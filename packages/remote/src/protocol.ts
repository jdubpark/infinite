import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const REMOTE_VERSION = 1;
export const MAX_REQUEST_BYTES = 96 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Hex encoding keeps the protocol independent of Buffer and native base64 APIs.
export const MAX_FRAME_BYTES = MAX_RESPONSE_BYTES * 2 + 4096;
export const MAX_PENDING_REQUESTS = 8;
export const MAX_TERMINAL_STREAMS = 4;
export const MAX_TERMINAL_BUFFERED_BYTES = 256 * 1024;
export const MAX_EVENTS_STREAMS = 4;
export const MAX_EVENTS_BUFFERED_BYTES = 256 * 1024;
export const MAX_EVENTS_EVENT_BYTES = 128 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RandomBytes = (length: number) => Uint8Array;
export type RemoteMethod = "GET" | "POST" | "PUT" | "DELETE";
export interface ClientHello { type: "hello"; version: 1; machineId: string; nonce: string; proof: string }
export interface ServerHello { type: "welcome"; version: 1; machineId: string; nonce: string; proof: string }
export interface CipherFrame { type: "ciphertext"; seq: number; data: string }
export interface RemoteRequest {
  type: "request"; id: string; token: string; method: RemoteMethod; path: string;
  headers?: Record<string, string>; body?: unknown;
}
export interface RemoteResponse { type: "response"; id: string; status: number; body: unknown }
/** Terminal messages retain the existing host gateway's input and lease rules. */
export type TerminalInput =
  | { op: "raw"; requestId: string; text: string; leaseId?: string }
  | { op: "input"; requestId: string; text: string; submit: false; leaseId?: string }
  | { op: "resize"; cols: number; rows: number; leaseId?: string }
  | { op: "control"; requestId: string; action: "claim" | "renew" | "release"; leaseId?: string; takeover?: boolean };
export type RemoteTerminalCommand =
  | { type: "terminal-open"; id: string; token: string; sessionId: string; clientId: string; after: number; snapshot: boolean }
  | { type: "terminal-send"; id: string; token: string; streamId: string; message: TerminalInput }
  | { type: "terminal-close"; id: string; token: string; streamId: string };
export type RemoteTerminalEvent =
  | { type: "terminal-event"; streamId: string; message: Record<string, unknown> }
  | { type: "terminal-closed"; streamId: string; code: number };
export type RemoteEventsCommand =
  | { type: "events-open"; id: string; token: string; topics: string[]; after: number }
  | { type: "events-close"; id: string; token: string; streamId: string };
export type RemoteEventsEvent =
  | { type: "events-event"; streamId: string; topic: string; data: unknown }
  | { type: "events-closed"; streamId: string; code: number; reason?: string };
export interface CipherChannel { seal(value: unknown): CipherFrame; open(frame: unknown): unknown; destroy(): void }
export type RelayEnvelope = { type: "open"; id: string } | { type: "close"; id: string } | { type: "data"; id: string; data: string };

const encode = utf8ToBytes;
const domain = "infinite-remote-v1";
const tokenPattern = /^[\x21-\x7e]{32,200}$/;
const noncePattern = /^[a-f0-9]{64}$/;

export function systemRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure random bytes are unavailable on this device");
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote message");
  return value as Record<string, unknown>;
}

export function tokenKey(token: string): Uint8Array {
  if (!tokenPattern.test(token)) throw new Error("Use a high-entropy paired device key");
  return sha256(encode(token));
}

export function keyFromHash(hash: string): Uint8Array {
  if (!noncePattern.test(hash)) throw new Error("Invalid paired device key hash");
  return hexToBytes(hash);
}

export function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let i = 0; i < first.length; i++) difference |= first[i] ^ second[i];
  return difference === 0;
}

function randomNonce(random: RandomBytes): string {
  const bytes = random(32);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error("Invalid random byte source");
  return bytesToHex(bytes);
}

function clientProof(key: Uint8Array, hello: Pick<ClientHello, "machineId" | "nonce">): string {
  return bytesToHex(hmac(sha256, key, encode(JSON.stringify([domain, "client", hello.machineId, hello.nonce]))));
}

export function createClientHello(key: Uint8Array, machineId: string, random: RandomBytes = systemRandomBytes): ClientHello {
  if (machineId !== "" && !UUID.test(machineId)) throw new Error("Invalid machine identifier");
  const hello = { type: "hello" as const, version: REMOTE_VERSION as 1, machineId, nonce: randomNonce(random) };
  return { ...hello, proof: clientProof(key, hello) };
}

export function parseClientHello(value: unknown): ClientHello {
  const frame = object(value);
  if (frame.type !== "hello" || frame.version !== REMOTE_VERSION || typeof frame.machineId !== "string" ||
      (frame.machineId !== "" && !UUID.test(frame.machineId)) || typeof frame.nonce !== "string" || !noncePattern.test(frame.nonce) ||
      typeof frame.proof !== "string" || !noncePattern.test(frame.proof) || Object.keys(frame).length !== 5) throw new Error("Invalid remote handshake");
  return frame as unknown as ClientHello;
}

export function matchesClientHello(key: Uint8Array, hello: ClientHello): boolean {
  return equalBytes(hexToBytes(clientProof(key, hello)), hexToBytes(hello.proof));
}

function transcript(client: ClientHello, server: Pick<ServerHello, "machineId" | "nonce">): Uint8Array {
  return encode(JSON.stringify([domain, client.machineId, server.machineId, client.nonce, server.nonce, client.proof]));
}

export function createServerHello(key: Uint8Array, client: ClientHello, machineId: string, random: RandomBytes = systemRandomBytes): ServerHello {
  if (!UUID.test(machineId) || (client.machineId !== "" && client.machineId !== machineId) || !matchesClientHello(key, client)) throw new Error("Remote authentication failed");
  const hello = { type: "welcome" as const, version: REMOTE_VERSION as 1, machineId, nonce: randomNonce(random) };
  return { ...hello, proof: bytesToHex(hmac(sha256, key, encode(JSON.stringify([domain, "server", bytesToHex(transcript(client, hello))])))) };
}

export function acceptServerHello(key: Uint8Array, client: ClientHello, value: unknown): ServerHello {
  const frame = object(value);
  if (frame.type !== "welcome" || frame.version !== REMOTE_VERSION || typeof frame.machineId !== "string" || !UUID.test(frame.machineId) ||
      (client.machineId !== "" && client.machineId !== frame.machineId) || typeof frame.nonce !== "string" || !noncePattern.test(frame.nonce) ||
      typeof frame.proof !== "string" || !noncePattern.test(frame.proof) || Object.keys(frame).length !== 5) throw new Error("Invalid remote handshake");
  const hello = frame as unknown as ServerHello;
  const proof = hmac(sha256, key, encode(JSON.stringify([domain, "server", bytesToHex(transcript(client, hello))])));
  if (!equalBytes(proof, hexToBytes(hello.proof))) throw new Error("Remote authentication failed");
  return hello;
}

/** Fresh nonces bind both directional keys to this handshake and machine. No forward secrecy. */
export function createCipherChannel(key: Uint8Array, client: ClientHello, server: ServerHello, side: "client" | "server"): CipherChannel {
  const context = sha256(transcript(client, server));
  const keys = hkdf(sha256, key, context, encode(`${domain}:directional-keys`), 64);
  const clientKey = keys.slice(0, 32), serverKey = keys.slice(32);
  keys.fill(0);
  let sent = 0, received = 0, destroyed = false;
  const nonce = (seq: number) => {
    const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
    view.setUint32(4, Math.floor(seq / 0x100000000)); view.setUint32(8, seq >>> 0);
    return bytes;
  };
  const associated = (direction: string, seq: number) => encode(JSON.stringify([domain, bytesToHex(context), direction, seq]));
  const sendDirection = side === "client" ? "client" : "server", receiveDirection = side === "client" ? "server" : "client";
  const sendKey = side === "client" ? clientKey : serverKey, receiveKey = side === "client" ? serverKey : clientKey;
  return {
    seal(value) {
      if (destroyed || !Number.isSafeInteger(sent)) throw new Error("Remote channel is closed");
      const plaintext = encode(JSON.stringify(value));
      if (plaintext.length > MAX_RESPONSE_BYTES + 1024) throw new Error("Remote message is too large");
      const seq = sent++;
      return { type: "ciphertext", seq, data: bytesToHex(gcm(sendKey, nonce(seq), associated(sendDirection, seq)).encrypt(plaintext)) };
    },
    open(value) {
      if (destroyed) throw new Error("Remote channel is closed");
      const frame = object(value);
      if (frame.type !== "ciphertext" || frame.seq !== received || !Number.isSafeInteger(frame.seq) || typeof frame.data !== "string" ||
          frame.data.length > MAX_FRAME_BYTES || frame.data.length < 32 || frame.data.length % 2 !== 0 || !/^[a-f0-9]+$/.test(frame.data) || Object.keys(frame).length !== 3) throw new Error("Invalid or replayed remote frame");
      const plaintext = gcm(receiveKey, nonce(received), associated(receiveDirection, received)).decrypt(hexToBytes(frame.data));
      const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      received++;
      return result;
    },
    destroy() { destroyed = true; clientKey.fill(0); serverKey.fill(0); context.fill(0); },
  };
}

export function parseRelayEnvelope(text: string): RelayEnvelope {
  if (text.length > MAX_FRAME_BYTES + 1024) throw new Error("Relay message is too large");
  const frame = object(JSON.parse(text));
  if (typeof frame.id !== "string" || !UUID.test(frame.id)) throw new Error("Invalid relay channel");
  if ((frame.type === "open" || frame.type === "close") && Object.keys(frame).length === 2) return frame as unknown as RelayEnvelope;
  if (frame.type === "data" && typeof frame.data === "string" && frame.data.length <= MAX_FRAME_BYTES && Object.keys(frame).length === 3) return frame as unknown as RelayEnvelope;
  throw new Error("Invalid relay envelope");
}

export function remoteSocketUrl(origin: string, path: string): string {
  const url = new URL(origin);
  if (!["https:", "wss:", "http:", "ws:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use a bare HTTPS machine or relay URL");
  if ((url.protocol === "http:" || url.protocol === "ws:") && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Remote connections require HTTPS");
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = path;
  return url.toString();
}
