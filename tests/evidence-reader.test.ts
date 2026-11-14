import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EvidenceReader, READER_REOPEN_MS } from "../packages/host/src/evidence/reader.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceModule } from "../packages/host/src/evidence/types.js";

const readerModule = new URL("../packages/host/src/evidence/reader.ts", import.meta.url).href;

/** A module `toy` at version 3 and read version 3, with one table and two committed rows. */
const toy: EvidenceModule = {
  name: "toy",
  version: 3,
  readVersion: 3,
  migrate(tx) {
    tx.exec("CREATE TABLE toy (n INTEGER)");
  },
};

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function seeded(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-evidence-reader-"));
  const path = evidenceDatabasePath(join(root, "state"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: path, vaultKey: key });
  store.register(toy);
  store.write(tx => {
    tx.run("INSERT INTO toy (n) VALUES (1)");
    tx.run("INSERT INTO toy (n) VALUES (2)");
  });
  return { root, path, key, close: () => rmSync(root, { recursive: true, force: true }) };
}

function reader(f: Fixture, modules: Record<string, number> = { toy: 3 }, now?: () => number): EvidenceReader {
  return new EvidenceReader({ databasePath: f.path, vaultKey: f.key, modules, now });
}

function count(r: EvidenceReader): number {
  return r.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM toy")!.n);
}

function unavailable(error: unknown): boolean {
  return error instanceof EvidenceError && error.code === "unavailable";
}

test("a reader sees only committed rows, from another process", () => {
  const f = seeded();
  try {
    const writer = new DatabaseSync(f.path);
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO toy (n) VALUES (3)");
    const childCount = (): string => {
      const script = `
        (async () => {
          const { EvidenceReader } = await import(process.env.READER_MODULE);
          const reader = new EvidenceReader({
            databasePath: process.env.DB_PATH,
            vaultKey: Buffer.from(process.env.VAULT_KEY, "hex"),
            modules: { toy: 3 },
          });
          const row = reader.read(db => db.get("SELECT count(*) AS n FROM toy"));
          reader.close();
          process.stdout.write(String(row.n));
        })().catch(error => { process.stderr.write(String(error)); process.exit(1); });
      `;
      const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, READER_MODULE: readerModule, DB_PATH: f.path, VAULT_KEY: f.key.toString("hex") },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.equal(childCount(), "2");
    writer.exec("COMMIT");
    assert.equal(childCount(), "3");
    writer.close();
  } finally {
    f.close();
  }
});

test("a reader refuses what it does not know", () => {
  const f = seeded();
  try {
    assert.throws(() => count(reader(f, { toy: 2 })), unavailable);
    assert.throws(() => count(new EvidenceReader({ databasePath: f.path, vaultKey: randomBytes(32), modules: { toy: 3 } })), unavailable);
    const raw = new DatabaseSync(f.path);
    raw.exec("UPDATE schema_modules SET version=2 WHERE name='store'");
    raw.close();
    assert.throws(() => count(reader(f)), unavailable);
  } finally {
    f.close();
  }
  const root = mkdtempSync(join(tmpdir(), "infinite-evidence-reader-"));
  try {
    const path = evidenceDatabasePath(join(root, "missing"));
    assert.throws(() => new EvidenceReader({ databasePath: path, vaultKey: randomBytes(32), modules: { toy: 3 } }).read(() => 0), unavailable);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(dirname(path)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reader never writes", () => {
  const f = seeded();
  try {
    const r = reader(f);
    const before = readFileSync(f.path);
    for (let i = 0; i < 10; i++) assert.equal(count(r), 2);
    assert.deepEqual(readFileSync(f.path), before);
    assert.throws(() => r.read(db => db.all("INSERT INTO toy (n) VALUES (9)")), unavailable);
    assert.equal(count(r), 2);
    r.close();
  } finally {
    f.close();
  }
});

test("a failed open waits before it opens again", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-evidence-reader-"));
  try {
    const path = evidenceDatabasePath(join(root, "state"));
    const key = randomBytes(32);
    let clock = 0;
    const r = new EvidenceReader({ databasePath: path, vaultKey: key, modules: { toy: 3 }, now: () => clock });
    assert.throws(() => count(r), unavailable);
    const store = new EvidenceStore({ databasePath: path, vaultKey: key });
    store.register(toy);
    store.write(tx => {
      tx.run("INSERT INTO toy (n) VALUES (1)");
      tx.run("INSERT INTO toy (n) VALUES (2)");
    });
    assert.equal(READER_REOPEN_MS, 5_000);
    clock = 4_000;
    assert.throws(() => count(r), unavailable);
    clock = 6_000;
    assert.equal(count(r), 2);
    r.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
