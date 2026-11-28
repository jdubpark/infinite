import type { Mission } from "../../packages/host/src/mission-types.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let handler: (body: unknown) => Promise<unknown> = async () => ({ id: "m1", revision: 1 });
let pollMission: Mission | null = null;

export function setRunRequestApiHandler(next: (body: unknown) => Promise<unknown>) {
  handler = next;
}

export function setPollMission(mission: Mission) {
  pollMission = mission;
}

export async function api<T>(_connection: unknown, _path: string, init?: { body?: unknown }): Promise<T> {
  return (await handler(init?.body)) as T;
}

export function connectionKey(connection: { id: string }) {
  return connection.id;
}

export function usePoll() {
  return {
    data: {
      mission: pollMission,
      me: { role: "owner", projects: [] },
      projects: { groups: [] },
      board: [],
      at: Date.parse("2026-11-27T01:00:00.000Z"),
    },
    online: true,
    stale: false,
    loading: false,
    refreshing: false,
    seen: "12:00:00",
    refresh: () => {},
  };
}

const comp = (name: string) => name;
export const ActivityIndicator = comp("ActivityIndicator");
export const Alert = { alert: () => {} };
export const Platform = { OS: "ios" };
export const Pressable = comp("Pressable");
export const RefreshControl = comp("RefreshControl");
export const ScrollView = comp("ScrollView");
export const StyleSheet = { hairlineWidth: 1, create: <T>(obj: T) => obj };
export const Text = comp("Text");
export const TextInput = comp("TextInput");
export const View = comp("View");

export const useRouter = () => ({ canGoBack: () => false, back: () => {}, replace: () => {}, push: () => {} });
export const FloatingNotice = () => null;
export const HaltBanner = () => null;
export const useKeyboardPadding = () => 0;
export const Button = () => null;
export const Card = () => null;
export const Chip = () => null;
export const TopBar = () => null;
export const Glyph = () => null;
export const StatusIcon = () => null;
export const DecisionOptions = () => null;
export const OutcomeNote = () => null;
export const RecommendationBlock = () => null;
export const Attempts = () => null;
export const MissionProgressSection = () => null;
export function RequestStatus() { return null; }
export function Section() { return null; }
export function SteerBox() { return null; }
export const t = { note: {}, body: {}, strong: {}, title: {}, warning: {}, error: {} };
