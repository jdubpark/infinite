import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nearestDirectoryDefault, saveDirectoryDefault } from "../packages/host/src/team-cli.js";

type DefaultEntry = { teamId: string; projectId?: string };

function createRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeUuid(counter: number) {
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function expectedDefault(
  directory: string,
  stopAt: string,
  dirDefaults: Map<string, DefaultEntry>,
  legacyDefaults: Map<string, DefaultEntry>,
) {
  for (let current = directory; ; current = dirname(current)) {
    const value = dirDefaults.get(current) ?? legacyDefaults.get(current);
    if (value) return { ...value, origin: current };
    if (current === stopAt || current === dirname(current)) break;
  }
  return undefined;
}

test("nearestDirectoryDefault preserves nearest-ancestor lookup and unrelated entries across legacy migration, overrides, and interrupted tmp writes", () => {
  const seeds = [1, 7, 42, 1337, 9001];

  for (const seed of seeds) {
    const next = createRng(seed);
    const root = realpathSync(mkdtempSync(join(tmpdir(), `infinite-team-defaults-sim-${seed}-`)));
    const defaultsPath = join(root, "state", "directory-defaults.json");
    const workspace = join(root, "workspace");
    const directories = [
      workspace,
      join(workspace, "org-a"),
      join(workspace, "org-a", "repo-1"),
      join(workspace, "org-a", "repo-1", "packages"),
      join(workspace, "org-a", "repo-1", "packages", "api"),
      join(workspace, "org-a", "repo-2"),
      join(workspace, "org-b"),
      join(workspace, "org-b", "repo-3", "nested"),
      join(workspace, "unrelated", "deep", "leaf"),
    ];
    for (const dir of directories) mkdirSync(dir, { recursive: true });
    mkdirSync(dirname(defaultsPath), { recursive: true });

    const legacyDefaults = new Map<string, DefaultEntry>();
    const dirDefaults = new Map<string, DefaultEntry>();
    let idCounter = seed * 1000;
    const makeEntry = (): DefaultEntry => {
      const teamId = makeUuid(++idCounter);
      return next() < 0.6 ? { teamId, projectId: makeUuid(++idCounter) } : { teamId };
    };

    try {
      const initialLegacyCount = 2 + Math.floor(next() * 3);
      for (let i = 0; i < initialLegacyCount; i++) {
        const dir = directories[Math.floor(next() * directories.length)];
        legacyDefaults.set(dir, makeEntry());
      }
      writeFileSync(defaultsPath, JSON.stringify({
        version: 1,
        directories: Object.fromEntries(legacyDefaults),
      }, null, 2));

      for (let step = 0; step < 35; step++) {
        const roll = next();
        const target = directories[Math.floor(next() * directories.length)];
        if (roll < 0.5) {
          const entry = makeEntry();
          saveDirectoryDefault(defaultsPath, target, entry);
          dirDefaults.set(target, entry);
        } else if (roll < 0.75) {
          const entry = makeEntry();
          legacyDefaults.set(target, entry);
          writeFileSync(defaultsPath, JSON.stringify({
            version: 1,
            directories: Object.fromEntries(legacyDefaults),
          }, null, 2));
        } else {
          const dirStore = `${defaultsPath}.d`;
          mkdirSync(dirStore, { recursive: true, mode: 0o700 });
          const hash = createHash("sha256").update(target).digest("hex");
          writeFileSync(join(dirStore, `${hash}.json.interrupted-${seed}-${step}.tmp`), "{\"version\":1,\"directory\":");
          writeFileSync(`${defaultsPath}.interrupted-${seed}-${step}.tmp`, "{\"version\":1");
        }

        for (const query of directories) {
          assert.deepEqual(
            nearestDirectoryDefault(defaultsPath, query),
            expectedDefault(query, root, dirDefaults, legacyDefaults),
            `seed=${seed} step=${step} query=${query}`,
          );
        }
        for (const [savedDir, expected] of dirDefaults) {
          const hash = createHash("sha256").update(savedDir).digest("hex");
          const disk = JSON.parse(readFileSync(join(`${defaultsPath}.d`, `${hash}.json`), "utf8"));
          assert.deepEqual(disk, { version: 1, directory: savedDir, ...expected });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
