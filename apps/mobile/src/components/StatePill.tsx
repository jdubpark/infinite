import type { AttentionState } from "@infinite/attention";
import { SESSION_KIND, SESSION_LABELS } from "../status";
import { Chip } from "./Glass";

/** A session's attention state as a status icon and its name. */
export function StatePill({ state }: { state: AttentionState }) {
  return <Chip kind={SESSION_KIND[state]} label={SESSION_LABELS[state]} accessibilityLabel={`State: ${SESSION_LABELS[state]}`}
    tone={state === "needs-you" ? "attention" : state === "unavailable" || state === "recording-error" ? "error" : undefined} />;
}
