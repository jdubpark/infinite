import { createHash } from "node:crypto";
import type express from "express";
import { z } from "zod";

const since = z.string().max(128).regex(/^[A-Za-z0-9_-]*$/).optional();

const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const isCmuxRow = (row: unknown): row is { backend: "cmux"; id: string } =>
  typeof row === "object" && row !== null && (row as { backend?: unknown }).backend === "cmux" && typeof (row as { id?: unknown }).id === "string";

function canonicalRows(rows: readonly unknown[]): unknown[] {
  const cmux = rows.filter(isCmuxRow);
  if (cmux.length < 2) return rows as unknown[];
  cmux.sort((left, right) => compareCodeUnits(left.id, right.id));
  let index = 0;
  return rows.map((row) => (isCmuxRow(row) ? cmux[index++] : row));
}

const sessionListVersion = (serialized: string) => createHash("sha256").update(serialized).digest("base64url").slice(0, 22);

export async function sendSessionList(req: express.Request, res: express.Response, list: () => Promise<unknown[]>) {
  const held = since.parse(req.query.since);
  const rows = canonicalRows(await list());
  if (held === undefined) return void res.json({ sessions: rows });
  const serialized = JSON.stringify(rows);
  const version = sessionListVersion(serialized);
  if (held === version) return void res.json({ version, unchanged: true });
  res.type("json").send(`{"version":"${version}","sessions":${serialized}}`);
}
