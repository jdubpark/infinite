import { closeConnection, connectionKey, type Connection } from "../api/client";
import { clearDrafts } from "./drafts";
import { clearConnection } from "./connection";
import { creations, goalCreations, lifecycles, missionCreations, runRequests, teamCreations } from "./requests";

/** Invalidates one pairing across tabs and all machine-scoped in-memory state. */
export function forgetMachine(connection: Connection) {
  const key = connectionKey(connection);
  closeConnection(connection);
  clearDrafts(key);
  creations.clear(key);
  lifecycles.clearMachine(key);
  teamCreations.clearMachine(key);
  goalCreations.clearMachine(key);
  missionCreations.clearMachine(key);
  runRequests.clearMachine(key);
  return clearConnection(key);
}
