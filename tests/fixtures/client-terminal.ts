import assert from "node:assert/strict";
import { waitFor } from "../helpers.js";

export async function returnToMonitorAndOpenDraft(input: {
  output: () => string;
  write: (data: string) => void;
  inputText: () => string;
  controlHeld: () => Promise<boolean>;
  expectedInput: string;
}) {
  const send = (keys: string) => {
    const offset = input.output().length;
    input.write(keys);
    return offset;
  };

  assert.equal(await input.controlHeld(), true, "the interactive terminal holds control before returning to monitor mode");
  const monitor = send("\x07ignored again");
  await waitFor(async () => input.output().slice(monitor).includes("Monitoring. Enter enables interaction;"), Boolean);
  await waitFor(input.controlHeld, held => !held, 25_000);
  assert.equal(input.inputText(), input.expectedInput, "monitor mode does not send ignored keys");

  let attempt = send("\r");
  await waitFor(async () => {
    const feedback = input.output().slice(attempt);
    if (feedback.includes("Interactive. Ctrl+G returns to monitoring;")) return true;
    if (feedback.includes("Waiting for control acknowledgement…")) attempt = send("\r");
    return false;
  }, Boolean, 25_000);

  const draft = send("\x05");
  await waitFor(async () => input.output().slice(draft).includes("Local draft"), Boolean, 25_000);
}
