import { createRequire } from "node:module";

const delay = Number(process.env.INFINITE_TEST_TERMINAL_DRAIN_DELAY_MS ?? 0);
let fast = Number(process.env.INFINITE_TEST_TERMINAL_DRAIN_FAST ?? 0);
if (delay) {
  const { Terminal } = createRequire(new URL("../../packages/host/src/worker.ts", import.meta.url))("@xterm/headless");
  const write = Terminal.prototype.write;
  Terminal.prototype.write = function (data, callback) {
    const slow = data === "" && callback && fast-- <= 0;
    return write.call(this, data, slow ? () => setTimeout(callback, delay) : callback);
  };
}
