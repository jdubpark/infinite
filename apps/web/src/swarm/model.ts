import { AGENT_STATES, type AgentState, type SwarmInput, type SwarmModel } from "./types";

/** Joins the host's session, team, and mission lists into the model the Swarm views render. */
export function buildSwarm(_input: SwarmInput): SwarmModel {
  const byState = Object.fromEntries(AGENT_STATES.map(state => [state, 0])) as Record<AgentState, number>;
  return { live: [], quiet: [], quietOlder: 0, totals: { byState, agents: 0, waitingOnPerson: 0, slots: { running: 0, limit: 0 }, costUsd: 0 } };
}
