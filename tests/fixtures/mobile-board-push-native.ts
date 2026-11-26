export * from "./mobile-push-native";
export { default } from "./mobile-push-native";
export * from "./react-hooks";
import type { Connection } from "./mobile-push-native";

export type NodeElement = { type: unknown; props: Record<string, unknown> };
export const jsx = (type: unknown, props: Record<string, unknown> | null): NodeElement => ({
  type,
  props: props ?? {},
});
export const jsxs = jsx;
export const Fragment = "Fragment";

export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T) {
    return styles;
  },
};

export const ActivityIndicator = "ActivityIndicator";
export const SafeAreaView = "SafeAreaView";
export const Board = "Board";
export const theme = { colors: { paper: "#fff", forest: "#123" } };

export const useRouter = () => ({ push: () => {}, replace: () => {} });
export const closeConnection = () => {};
export const identifyConnection = async () => {};
export const forgetMachine = async () => {};

let sharedMachine: {
  loaded: boolean;
  active: string;
  connection: Connection | null;
  profiles: Connection[];
  select: (id: string) => Promise<void>;
} = {
  loaded: true,
  active: "machine-a",
  connection: { id: "machine-a", url: "http://127.0.0.1:4101", token: "tok-a" },
  profiles: [{ id: "machine-a", url: "http://127.0.0.1:4101", token: "tok-a" }],
  select: async () => {},
};

export function setSharedMachine(profiles: Connection[], active: string) {
  sharedMachine = {
    loaded: true,
    active,
    connection: profiles.find(profile => (profile.id ?? profile.url) === active) ?? null,
    profiles,
    select: async () => {},
  };
}

export function useSharedMachine() {
  return sharedMachine;
}
