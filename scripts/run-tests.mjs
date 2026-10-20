import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// These integration files are sensitive to PTY contention or short lease and provider-flush windows.
const serialFiles = new Set(["continuity.test.ts", "summary.test.ts", "worker-attention.test.ts"]);
const testFiles = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const parallelFiles = testFiles.filter((name) => !serialFiles.has(name));
const serial = testFiles.filter((name) => serialFiles.has(name));
const requestedConcurrency = process.argv.find((arg) => arg.startsWith("--concurrency="))?.split("=", 2)[1];
const concurrency = requestedConcurrency === undefined ? 4 : Number(requestedConcurrency);

if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("Usage: npm test -- --concurrency=<positive integer>");
}

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));

function run(files, fileConcurrency) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, "--test", `--test-concurrency=${fileConcurrency}`, ...files.map((file) => `tests/${file}`)], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Test process failed (${signal ?? code})`));
    });
  });
}

await run(parallelFiles, concurrency);
await run(serial, 1);
