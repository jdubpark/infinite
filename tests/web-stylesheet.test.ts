import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

test("the web stylesheet parses without a CSS warning", async () => {
  const css = await readFile(new URL("../apps/web/src/style.css", import.meta.url), "utf8");
  const { warnings } = await transform(css, { loader: "css", logLevel: "silent" });
  assert.deepEqual(warnings.map(warning => `${warning.location?.line}: ${warning.text}`), []);
});
