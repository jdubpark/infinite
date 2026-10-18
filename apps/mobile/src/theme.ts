import { Platform } from "react-native";

/** Colour tokens from DESIGN.md (frontmatter `colors`), camel-cased. */
export const colors = {
  canvas: "#eeeee7",
  paper: "#fafaf6",
  ink: "#222a27",
  mutedInk: "#59645e",
  rule: "#d5d9d1",
  forest: "#23654e",
  white: "#ffffff",
  fieldRule: "#bcc6b9",
  placeholder: "#687469",
  focus: "#518d75",
  selectedRow: "#dce3d5",
  secondarySurface: "#edf0e7",
  secondaryInk: "#35533c",
  screenSurface: "#eef1e9",
  screenInk: "#334431",
  running: "#307d54",
  warningSurface: "#f7e8ce",
  warningInk: "#724314",
  error: "#9d382a",
  terminalSurface: "#202923",
  terminalInk: "#e4e9de",
  /** Floating controls: a translucent sheet over the content, edged by a light rim. */
  glass: "rgba(252,252,249,0.86)",
  glassRim: "rgba(34,42,39,0.10)",
  scrim: "rgba(24,30,27,0.28)",
} as const;

export const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

/** DESIGN.md `rounded`: control, native-message, panel, pairing-sheet; capsule for floating controls. */
export const radius = { control: 8, message: 10, panel: 12, card: 16, sheet: 28, capsule: 999 } as const;

/** DESIGN.md `spacing`. */
export const space = { compact: 8, label: 12, controlX: 18, inset: 20, section: 24 } as const;

/** The one depth used by floating controls and sheets; content stays flat. */
export const lift = { boxShadow: "0 6px 18px rgba(24,30,27,0.14)" } as const;

export const theme = { colors, mono, radius, space, lift } as const;
