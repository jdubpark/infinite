import { createHash } from "node:crypto";
import type express from "express";
import { z } from "zod";

const since = z.string().max(128).regex(/^[A-Za-z0-9_-]*$/).optional();

const sessionListVersion = (serialized: string) => createHash("sha256").update(serialized).digest("base64url").slice(0, 22);

export async function sendSessionList(req: express.Request, res: express.Response, list: () => Promise<unknown[]>) {
  const held = since.parse(req.query.since);
  if (held === undefined) return void res.json({ sessions: await list() });
  const serialized = JSON.stringify(await list());
  const version = sessionListVersion(serialized);
  if (held === version) return void res.json({ version, unchanged: true });
  res.type("json").send(`{"version":"${version}","sessions":${serialized}}`);
}
