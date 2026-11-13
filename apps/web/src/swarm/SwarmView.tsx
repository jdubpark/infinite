import type { Me } from "../api";
import type { SwarmSession, SwarmTeam } from "./types";
import "./swarm.css";

export type SwarmViewName = "lanes" | "wall" | "graph";
export type SwarmViewProps = {
  me: Me;
  sessions: SwarmSession[];
  teams: SwarmTeam[];
  /** Freshness of the app's session and team feeds. */
  fresh: boolean;
  stale: boolean;
  seen: string;
  view: SwarmViewName;
  setView(view: SwarmViewName): void;
  openSession(sessionId: string): void;
  openTeam(teamId: string): void;
  /** Starts a session; shown to owners when the host has no sessions at all. */
  onCreate?: () => void;
  focus: boolean;
  setFocus(focus: boolean): void;
};

/** The Swarm route: floating glass controls over the Lanes, Wall, or Graph canvas. */
export function SwarmView(_props: SwarmViewProps) {
  return <div className="swarm" />;
}
