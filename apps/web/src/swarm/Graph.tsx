import type { ViewProps } from "./types";

export type GraphProps = ViewProps & {
  /** False when the host predates the context endpoints; the view then draws without a code map or observed touches. */
  contextAvailable: boolean;
};

/** Swarm topology linked to the code context in use. */
export function Graph(_props: GraphProps) {
  return null;
}
