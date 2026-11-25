import assert from "node:assert/strict";
import { waitFor } from "../helpers.js";

export async function acquireInteractiveTerminal(output: () => string, write: (data: string) => void) {
  let offset = output().length;
  write("\r");
  await waitFor(async () => {
    const feedback = output().slice(offset);
    if (feedback.includes("Interactive. Ctrl+G returns to monitoring;")) return true;
    if (feedback.includes("Waiting for control acknowledgement…")) { offset = output().length; write("\r"); }
    return false;
  }, Boolean, 25_000);
}

export async function openLocalDraft(output: () => string, write: (data: string) => void, expectedText?: string) {
  let offset = output().length;
  write("\x05");
  await waitFor(async () => {
    const fresh = output().slice(offset);
    if (fresh.includes("Local draft") && (expectedText === undefined || fresh.includes(expectedText))) return true;
    if (fresh.includes("Waiting for draft insertion. Input is disabled until delivery is confirmed.")) {
      offset = output().length;
      write("\x05");
    }
    return false;
  }, Boolean, 25_000);
}

export async function discardLocalDraft(output: () => string, write: (data: string) => void) {
  const offset = output().length;
  write("\x18");
  await waitFor(async () => output().slice(offset).includes("\x1b[?1049l"), Boolean, 25_000);
}

export async function insertLocalDraft(input: {
  output: () => string;
  write: (data: string) => void;
  inputText: () => string;
  expectedInput: string;
  text: string;
}) {
  const offset = input.output().length;
  input.write(input.text);
  await waitFor(async () => input.output().slice(offset).includes(input.text.split("\r").at(-1)!), Boolean);
  input.write("\x13");
  await waitFor(async () => input.inputText() === input.expectedInput, Boolean);
}

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

  await acquireInteractiveTerminal(input.output, input.write);

  await openLocalDraft(input.output, input.write);
}
