import { readFileSync, writeFileSync } from "node:fs";

const now = Date.now;
process.on("SIGUSR2", () => {
  const file = process.env.INFINITE_TEST_CLOCK_FILE;
  const offset = Number(readFileSync(file, "utf8"));
  Date.now = () => now() + offset;
  writeFileSync(file, `moved ${offset}`);
});
