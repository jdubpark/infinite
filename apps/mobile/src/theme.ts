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
} as const;

export const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

/** DESIGN.md `rounded`: control, native-message, panel, pairing-sheet. */
export const radius = { control: 8, message: 10, panel: 12, sheet: 16 } as const;

/** DESIGN.md `spacing`. */
export const space = { compact: 8, label: 12, controlX: 18, inset: 20, section: 24 } as const;

export const theme = { colors, mono, radius, space } as const;
