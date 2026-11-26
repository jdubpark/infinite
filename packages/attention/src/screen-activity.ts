import type { Provider } from "./types.js";

export interface ScreenActivityState {
  fingerprint?: string;
  lastSubstantiveAtMs?: number;
  spinnerOnlySinceMs?: number;
}

export interface ScreenActivityEvaluation {
  nextState: ScreenActivityState;
  substantiveChange: boolean;
  spinnerOnly: boolean;
  spinnerOnlySince?: string;
}

const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const BRAILLE_SPINNER_RE = /[\u2800-\u28ff]+/g;
const CIRCLE_SPINNER_RE = /[◐◓◑◒◴◷◶◵]/g;
const CLAUDE_SPINNER_RE = /(?:^|\s)[·✢✳✶✻✽](?=\s|$)/g;
const CODEX_SPINNER_RE = /(?:^|\s)[•◦](?=\s)/g;
const ASCII_SPIN_TOKEN_RE = /(?:^|\s)[|/\-\\](?=\s|$)/g;
const PAREN_TIMER_RE = /\(\s*(?:(?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?s|\d{1,2}:\d{2}(?::\d{2})?)\s*\)/g;
const COMPOUND_TIMER_RE = /\b\d+h(?:\s+\d+m)?(?:\s+\d+(?:\.\d+)?s)?\b|\b\d+m\s+\d+(?:\.\d+)?s\b/g;
const CLOCK_TIMER_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const SECONDS_TIMER_RE = /\b\d+(?:\.\d+)?s\b/g;
const TOKEN_TICKER_RE = /(?:[↑↓]\s*)?\b\d[\d,]*(?:\.\d+)?[kKmM]?\s+tokens?\b/gi;
const COST_TICKER_RE = /\$\d[\d,]*(?:\.\d+)?\b/g;
const LABELED_TICKER_RE = /\b(?:tokens?|cost)\s*[:=]\s*\$?\d[\d,]*(?:\.\d+)?[kKmM]?\b/gi;
const STATUS_CUE_RE = /\b(?:tokens?|cost|context|esc to interrupt|cached|reasoning|claude|codex|opencode|grok)\b|[·•|]/i;
const STATUS_PERCENT_RE = /\b\d+(?:\.\d+)?%/g;
const EMPTY_PARENS_RE = /\(\s*[·•,|/\-\s]*\)/g;

function normalizeLine(raw: string, provider: Provider): string {
  let line = raw.replace(ANSI_ESCAPE_RE, "").replace(/\s+$/g, "");
  if (!line) return "";
  const statusLine = STATUS_CUE_RE.test(line);
  line = line
    .replace(BRAILLE_SPINNER_RE, " ")
    .replace(CIRCLE_SPINNER_RE, " ")
    .replace(ASCII_SPIN_TOKEN_RE, " ");
  if (provider === "claude") line = line.replace(CLAUDE_SPINNER_RE, " ");
  if (provider === "codex") line = line.replace(CODEX_SPINNER_RE, " ");
  line = line
    .replace(LABELED_TICKER_RE, (match) => match.split(/[:=]/)[0] + ":")
    .replace(TOKEN_TICKER_RE, " ");
  if (statusLine) {
    line = line
      .replace(COST_TICKER_RE, " ")
      .replace(STATUS_PERCENT_RE, " ");
  }
  line = line
    .replace(PAREN_TIMER_RE, " ")
    .replace(COMPOUND_TIMER_RE, " ")
    .replace(CLOCK_TIMER_RE, " ")
    .replace(SECONDS_TIMER_RE, " ")
    .replace(EMPTY_PARENS_RE, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return line;
}

export function substantiveScreenFingerprint(lines: readonly string[], provider: Provider): string {
  const normalized: string[] = [];
  for (const line of lines) {
    const clean = normalizeLine(line, provider);
    if (clean) normalized.push(clean);
  }
  return normalized.join("\n");
}

export function evaluateScreenActivity(
  state: ScreenActivityState | undefined,
  lines: readonly string[],
  provider: Provider,
  rawOutputSinceCheck: boolean,
  nowMs: number,
): ScreenActivityEvaluation {
  const fingerprint = substantiveScreenFingerprint(lines, provider);
  if (state === undefined || state.fingerprint === undefined) {
    if (rawOutputSinceCheck && fingerprint === "") {
      const sinceMs = state?.spinnerOnlySinceMs ?? nowMs;
      return {
        nextState: {
          fingerprint,
          lastSubstantiveAtMs: state?.lastSubstantiveAtMs,
          spinnerOnlySinceMs: sinceMs,
        },
        substantiveChange: false,
        spinnerOnly: true,
        spinnerOnlySince: new Date(sinceMs).toISOString(),
      };
    }
    const lastSubstantiveAtMs = rawOutputSinceCheck ? nowMs : (state?.lastSubstantiveAtMs ?? nowMs);
    return {
      nextState: {
        fingerprint,
        lastSubstantiveAtMs,
      },
      substantiveChange: rawOutputSinceCheck && fingerprint !== "",
      spinnerOnly: false,
    };
  }
  if (fingerprint !== state.fingerprint) {
    return {
      nextState: {
        fingerprint,
        lastSubstantiveAtMs: nowMs,
      },
      substantiveChange: true,
      spinnerOnly: false,
    };
  }
  if (rawOutputSinceCheck) {
    const sinceMs = state.spinnerOnlySinceMs ?? nowMs;
    return {
      nextState: {
        fingerprint,
        lastSubstantiveAtMs: state.lastSubstantiveAtMs,
        spinnerOnlySinceMs: sinceMs,
      },
      substantiveChange: false,
      spinnerOnly: true,
      spinnerOnlySince: new Date(sinceMs).toISOString(),
    };
  }
  if (state.spinnerOnlySinceMs !== undefined) {
    return {
      nextState: {
        fingerprint,
        lastSubstantiveAtMs: state.lastSubstantiveAtMs,
        spinnerOnlySinceMs: state.spinnerOnlySinceMs,
      },
      substantiveChange: false,
      spinnerOnly: true,
      spinnerOnlySince: new Date(state.spinnerOnlySinceMs).toISOString(),
    };
  }
  return {
    nextState: {
      fingerprint,
      lastSubstantiveAtMs: state.lastSubstantiveAtMs,
    },
    substantiveChange: false,
    spinnerOnly: false,
  };
}
