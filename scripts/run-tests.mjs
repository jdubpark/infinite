import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const serialFiles = new Set(["client-cli.test.ts", "continuity.test.ts", "laptop-service.test.ts", "main-check-real.test.ts", "summary.test.ts", "worker-attention.test.ts"]);
const testFiles = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const parallelFiles = testFiles.filter((name) => !serialFiles.has(name));
const serial = testFiles.filter((name) => serialFiles.has(name));
const requestedConcurrency = process.argv.find((arg) => arg.startsWith("--concurrency="))?.split("=", 2)[1]
  ?? process.env.INFINITE_TEST_CONCURRENCY;
const concurrency = requestedConcurrency === undefined ? 4 : Number(requestedConcurrency);

if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("Test concurrency must be a positive integer. Set --concurrency or INFINITE_TEST_CONCURRENCY.");
}

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));

async function run(files, fileConcurrency) {
  const report = !process.stdout.isTTY;
  const child = spawn(process.execPath, [tsx, "--test", `--test-concurrency=${fileConcurrency}`, ...files.map((file) => `tests/${file}`)], {
    stdio: ["inherit", report ? "pipe" : "inherit", "inherit"],
  });
  const failed = [];
  const finished = [once(child, "close")];
  if (report) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      process.stdout.write(`${line}\n`);
      const name = /^\s*not ok \d+ - (.*)$/.exec(line)?.[1];
      if (name !== undefined && !/ # (?:SKIP|TODO)\b/i.test(name)) failed.push(name);
    });
    finished.push(once(lines, "close"));
  }
  const [[code, signal]] = await Promise.all(finished);
  if (failed.length) process.stdout.write(`# failed tests (${failed.length}):\n${failed.map((name) => `#   ${name}`).join("\n")}\n`);
  if (code !== 0) throw new Error(`Test process failed (${signal ?? code})`);
}

await run(parallelFiles, concurrency);
await run(serial, 1);
