import type { ReactNode } from "react";

type AppStateStatus = "active" | "inactive" | "background";
type AppStateListener = (state: AppStateStatus) => void;
const appStateListeners = new Set<AppStateListener>();

export const AppState = {
  currentState: "active" as AppStateStatus,
  addEventListener(_event: "change", listener: AppStateListener) {
    appStateListeners.add(listener);
    return { remove: () => void appStateListeners.delete(listener) };
  },
};

export const Platform = {
  OS: "ios",
  select<T>(specifics: { ios?: T; android?: T; default?: T }) {
    return specifics.ios ?? specifics.default;
  },
};

export const StyleSheet = {
  hairlineWidth: 1,
  create<T extends Record<string, unknown>>(styles: T) {
    return styles;
  },
};

export function View({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

export function ScrollView({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

export function RefreshControl() {
  return null;
}

export function ActivityIndicator() {
  return <span role="progressbar">Loading</span>;
}

export function Text({
  children,
  accessibilityRole,
  accessibilityLiveRegion,
}: {
  children?: ReactNode;
  accessibilityRole?: string;
  accessibilityLiveRegion?: "none" | "polite" | "assertive";
}) {
  const role = accessibilityRole === "header" ? "heading" : accessibilityRole;
  const live = accessibilityLiveRegion === "none" ? "off" : accessibilityLiveRegion;
  return <p role={role} aria-live={live}>{children}</p>;
}

export function Pressable({
  children,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return <button type="button" disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>{children}</button>;
}

export function Button({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress?: () => void }) {
  return <button type="button" disabled={disabled} onClick={onPress}>{title}</button>;
}

export function TopBar({ backLabel, onBack, right }: { backLabel: string; onBack: () => void; right?: ReactNode }) {
  return <header><button type="button" onClick={onBack}>{backLabel}</button>{right}</header>;
}

export function LiveStatus() {
  return <span />;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
}) {
  return <div role="group">{options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

export function Glyph() {
  return null;
}

export function Section({ title, children }: { title: string; count?: number; children?: ReactNode }) {
  return <section><h2>{title}</h2>{children}</section>;
}

export const t = {
  banner: {},
  mono: {},
  note: {},
  error: {},
};

export function useRouter() {
  return {
    push: () => {},
    replace: () => {},
    back: () => {},
    canGoBack: () => false,
  };
}

export const useIsFocused = () => true;

export type Connection = { id?: string; url: string; token: string };
export const connectionKey = (connection: Connection) => connection.id ?? connection.url;
export const ago = () => "1s ago";

export async function api<T>(_connection: Connection, path: string): Promise<T> {
  const response = await fetch(`/api${path}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Connection failed");
  return data as T;
}
