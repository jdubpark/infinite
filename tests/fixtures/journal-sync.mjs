import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const delay = Number(process.env.INFINITE_TEST_JOURNAL_SYNC_DELAY_MS ?? 0);
const report = process.env.INFINITE_TEST_JOURNAL_SYNC_REPORT;
const failBatches = process.env.INFINITE_TEST_JOURNAL_SYNC_FAIL === "1";
const { openSync, closeSync, writeSync, fsyncSync, writeFileSync } = fs;
const unsynced = new Map();
const gate = new Int32Array(new SharedArrayBuffer(4));
let synced = 0;
let largest = 0;
let failing = false;

fs.openSync = (path, ...rest) => {
  const fd = openSync(path, ...rest);
  if (String(path).endsWith(".journal")) unsynced.set(fd, 0);
  return fd;
};
fs.closeSync = fd => {
  unsynced.delete(fd);
  return closeSync(fd);
};
fs.writeSync = (fd, data, ...rest) => {
  const written = writeSync(fd, data, ...rest);
  if (unsynced.has(fd) && typeof data !== "string") {
    const start = typeof rest[0] === "number" ? rest[0] : 0;
    let lines = 0;
    for (let at = data.indexOf(10, start); at !== -1 && at < start + written; at = data.indexOf(10, at + 1)) lines++;
    unsynced.set(fd, unsynced.get(fd) + lines);
  }
  return written;
};
fs.fsyncSync = fd => {
  if (!unsynced.has(fd)) return fsyncSync(fd);
  const lines = unsynced.get(fd);
  if (delay) Atomics.wait(gate, 0, 0, delay);
  if (failBatches && (failing ||= lines > 1)) throw Object.assign(new Error("Injected journal sync failure"), { code: "EIO" });
  fsyncSync(fd);
  unsynced.set(fd, 0);
  synced += lines;
  largest = Math.max(largest, lines);
  if (report) writeFileSync(report, JSON.stringify({ synced, largest }));
};
syncBuiltinESMExports();
