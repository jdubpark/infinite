import { AGENT_STATES, type Agent, type AgentState, type Swarm, type SwarmInput, type SwarmModel, type Unit } from "./types";

/** Joins the host's session, team, and mission lists into the model the Swarm views render. */
export function buildSwarm(_input: SwarmInput): SwarmModel {
  const byState = Object.fromEntries(AGENT_STATES.map(state => [state, 0])) as Record<AgentState, number>;
  return { live: [], quiet: [], quietOlder: 0, totals: { byState, agents: 0, waitingOnPerson: 0, slots: { running: 0, limit: 0 }, costUsd: 0 } };
}

/** The coordinator, then each unit's agents and side agents, then solo sessions. */
export function allAgents(swarm: Swarm): Agent[] {
  return [...(swarm.coordinator ? [swarm.coordinator] : []), ...swarm.units.flatMap(unit => [...unit.agents, ...unit.side]), ...swarm.loose];
}

export function findAgent(model: SwarmModel, id: string): Agent | undefined {
  for (const swarm of [...model.live, ...model.quiet]) for (const agent of allAgents(swarm)) if (agent.id === id) return agent;
  return undefined;
}

export function findUnit(model: SwarmModel, id: string): Unit | undefined {
  for (const swarm of [...model.live, ...model.quiet]) for (const unit of swarm.units) if (unit.id === id) return unit;
  return undefined;
}
