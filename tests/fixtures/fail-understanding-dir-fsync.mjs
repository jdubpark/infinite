import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname } from "node:path";

const original = fs.fsyncSync.bind(fs);
const originalOpen = fs.openSync.bind(fs);
const originalClose = fs.closeSync.bind(fs);
const originalUnlink = fs.unlinkSync.bind(fs);
const target = process.env.INFINITE_FAIL_DIR_SYNC;
const failFileSync = process.env.INFINITE_FAIL_FILE_SYNC === "1";
const denyCleanup = process.env.INFINITE_DENY_TEMP_CLEANUP;
const targetDescriptors = new Set();
let remainingFailures = Number(process.env.INFINITE_FAIL_DIR_SYNC_COUNT ?? 1);
fs.openSync = (path, ...args) => {
  const fd = originalOpen(path, ...args);
  if (target && typeof path === "string" && (failFileSync
    ? dirname(path) === target && /^[0-9a-f-]{36}\.sealed\.[0-9a-f]{16}\.tmp$/.test(basename(path))
    : path === target && fs.fstatSync(fd).isDirectory())) targetDescriptors.add(fd);
  return fd;
};
fs.closeSync = fd => { targetDescriptors.delete(fd); return originalClose(fd); };
fs.unlinkSync = path => {
  if (denyCleanup && fs.existsSync(denyCleanup) && typeof path === "string" && dirname(path) === target && /^[0-9a-f-]{36}\.sealed\.[0-9a-f]{16}\.tmp$/.test(basename(path)))
    throw Object.assign(new Error("Injected temporary artifact cleanup failure"), { code: "EACCES" });
  return originalUnlink(path);
};
fs.fsyncSync = fd => {
  if (remainingFailures > 0 && targetDescriptors.has(fd)) {
    remainingFailures--;
    throw Object.assign(new Error(failFileSync ? "Injected file sync failure before rename" : "Injected directory sync failure after rename"), { code: "EIO" });
  }
  return original(fd);
};
syncBuiltinESMExports();
