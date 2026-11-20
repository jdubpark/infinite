import { createHash } from "node:crypto";
import type express from "express";
import { z } from "zod";

/**
 * The version a client last read. Empty means it holds none and asks for one. The bound and alphabet admit every
 * version this host names and leave room for another digest later: a well-formed version that is not current only
 * answers the whole list.
 */
const since = z.string().max(128).regex(/^[A-Za-z0-9_-]*$/).optional();

/**
 * Names one serialized session list: a SHA-256 digest of its bytes, cut to 22 base64url characters (132 bits). Equal
 * bytes give an equal version and a change to any byte of any row gives a new one, so the order of the rows counts.
 * After a host restart the version holds only when the rows come back in the same order: cmux rows keep the order
 * their directory was enumerated in on load, which the platform does not guarantee, and a changed order costs a client
 * one full read.
 */
const sessionListVersion = (serialized: string) => createHash("sha256").update(serialized).digest("base64url").slice(0, 22);

/**
 * `GET /api/sessions`. Without `since` it answers `{ sessions }`, the envelope and content type installed clients read. With `since` it
 * answers `{ version, unchanged: true }` when the list is still that version, else `{ version, sessions }`. A malformed
 * `since` is refused before the list is built. The rows are serialized once, for both the digest and the body.
 */
export async function sendSessionList(req: express.Request, res: express.Response, list: () => Promise<unknown[]>) {
  const held = since.parse(req.query.since);
  if (held === undefined) return void res.json({ sessions: await list() });
  const serialized = JSON.stringify(await list());
  const version = sessionListVersion(serialized);
  if (held === version) return void res.json({ version, unchanged: true });
  res.type("json").send(`{"version":"${version}","sessions":${serialized}}`);
}
