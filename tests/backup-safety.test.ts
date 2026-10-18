import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("online backup covers both service cgroups and thaws safely on failure", { skip: process.platform === "win32" }, () => {
  execFileSync("python3", [fileURLToPath(new URL("./backup_safety.py", import.meta.url))], { stdio: "pipe" });
});
