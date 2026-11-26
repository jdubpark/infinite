import { createRequire } from "node:module";

const delay = Number(process.env.INFINITE_TEST_TERMINAL_DRAIN_DELAY_MS ?? 0);
if (delay) {
  const { Terminal } = createRequire(new URL("../../packages/host/src/worker.ts", import.meta.url))("@xterm/headless");
  const write = Terminal.prototype.write;
  Terminal.prototype.write = function (data, callback) {
    return write.call(this, data, data === "" && callback ? () => setTimeout(callback, delay) : callback);
  };
}
