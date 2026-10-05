import type { Terminal } from "@xterm/headless";
import serialize from "@xterm/addon-serialize";

/** Track parser boundaries and state that the public xterm serializer omits. */
export class TerminalSnapshots {
  private readonly serializer = new serialize.SerializeAddon();
  private parser: "ground" | "escape" | "csi" | "osc" | "string" = "ground";
  private sequence = "";
  private stringEscape = false;
  private osc = "";
  private oscTruncated = false;
  private readonly titles = new Map<number, string>();
  private statefulOsc = false;
  private extendedSgr = false;
  private highSurrogate = false;
  private unsupported = new Set<string>();
  private modes = new Map<number, boolean>();
  private cursorStyle = "";

  constructor(private readonly terminal: Terminal) {
    terminal.loadAddon(this.serializer);
  }

  observe(data: string) {
    this.highSurrogate = /[\ud800-\udbff]$/.test(data);
    for (const char of data) {
      const code = char.charCodeAt(0);
      if (code === 0x18 || code === 0x1a) {
        this.parser = "ground";
        this.sequence = "";
        continue;
      }
      if (this.parser === "osc" || this.parser === "string") {
        if (code === 0x9c || (this.stringEscape && char === "\\") || (this.parser === "osc" && code === 7)) {
          if (this.parser === "osc") this.finishOsc();
          this.parser = "ground";
          this.stringEscape = false;
        } else {
          if (this.parser === "osc") {
            // An embedded non-terminating ESC has parser-specific behavior; do not reconstruct it.
            if (this.stringEscape) this.statefulOsc = true;
            if (code !== 0x1b) {
              if (this.osc.length >= 4100) this.oscTruncated = true;
              else this.osc += char;
            }
          }
          this.stringEscape = code === 0x1b;
        }
        continue;
      }
      if (code === 0x1b) {
        this.parser = "escape";
        this.sequence = "";
        continue;
      }
      if (code === 0x9b) { this.parser = "csi"; this.sequence = ""; continue; }
      if (code === 0x9d) { this.parser = "osc"; this.stringEscape = false; this.osc = ""; this.oscTruncated = false; continue; }
      if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
        this.parser = "string"; this.stringEscape = false;
        this.unsupported.add("terminal-string");
        continue;
      }
      if (code < 0x20 || code === 0x7f) continue;
      if (this.parser === "ground") continue;
      if (this.parser === "escape" && !this.sequence) {
        if (char === "[") { this.parser = "csi"; continue; }
        if (char === "]") { this.parser = "osc"; this.stringEscape = false; this.osc = ""; this.oscTruncated = false; continue; }
        if (["P", "X", "^", "_"].includes(char)) {
          this.parser = "string"; this.stringEscape = false;
          this.unsupported.add("terminal-string");
          continue;
        }
      }
      this.sequence = (this.sequence + char).slice(0, 513);
      if (this.sequence.length > 512) this.unsupported.add("oversized-sequence");
      if (this.parser === "csi" && code >= 0x40 && code <= 0x7e) {
        this.csi(this.sequence);
        this.parser = "ground";
      } else if (this.parser === "escape" && code >= 0x30 && code <= 0x7e) {
        if (this.sequence === "c") {
          this.unsupported.clear(); this.modes.clear(); this.cursorStyle = "";
        } else if (["7", "8", "H"].includes(this.sequence) || this.sequence.length > 1) {
          // Saved cursors, custom tab stops and character sets have no public serializer.
          this.unsupported.add("escape-state");
        }
        this.parser = "ground";
      }
    }
  }

  private finishOsc() {
    const match = /^(\d+);([\s\S]*)$/.exec(this.osc);
    const code = match ? Number(match[1]) : -1;
    const value = match?.[2] ?? "";
    if (!this.oscTruncated && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value)) {
      if ([0, 1, 2].includes(code)) {
        if (code === 0 || code === 1) this.titles.set(1, value);
        if (code === 0 || code === 2) this.titles.set(2, value);
        return;
      }
      // These requests do not mutate a terminal's colors or frame. Other OSCs, including
      // hyperlink/palette/default-color changes, cannot be represented by cell serialization.
      if ((code === 4 && /^\d+;\?(?:;\d+;\?)*$/.test(value)) ||
          (code >= 10 && code <= 19 && /^\?(?:;\?)*$/.test(value)) ||
          (code === 9 && !/^\d+;/.test(value))) return;
    }
    // RIS does not restore the terminal's palette/default colors. Remain conservative for the
    // worker lifetime even if a subsequent reset clears the visible screen and ordinary modes.
    this.statefulOsc = true;
  }

  private csi(sequence: string) {
    const final = sequence.at(-1);
    const params = sequence.slice(0, -1);
    if ((final === "h" || final === "l") && /^\?[\d;]+$/.test(params)) {
      const enabled = final === "h";
      for (const mode of params.slice(1).split(";").map(Number)) {
        if ([5, 12, 25, 1005, 1006, 1015].includes(mode)) this.modes.set(mode, enabled);
        else if (mode === 2026) {
          if (enabled) this.unsupported.add("synchronized-output");
          else this.unsupported.delete("synchronized-output");
        } else if (![1, 6, 7, 9, 45, 66, 1000, 1002, 1003, 1004, 1049, 2004].includes(mode)) {
          this.unsupported.add(`mode-${mode}`);
        }
      }
    } else if ((final === "h" || final === "l") && params !== "4") {
      this.unsupported.add("ansi-mode");
    } else if (final === "r" && /^[\d;]*$/.test(params)) {
      if (!params || params === `1;${this.terminal.rows}`) this.unsupported.delete("scroll-region");
      else this.unsupported.add("scroll-region");
    } else if (final === "s" || final === "u" || final === "g" || (final === "m" && params.startsWith(">"))) {
      this.unsupported.add("cursor-or-keyboard-state");
    } else if (final === "m") {
      this.sgr(params);
    } else if (final === "q" && /^\d* $/.test(params)) {
      this.cursorStyle = `\x1b[${sequence}`;
    }
  }

  private sgr(params: string) {
    const attributes = params.split(";");
    for (let i = 0; i < attributes.length; i++) {
      const [rawCode, underlineStyle] = attributes[i].split(":");
      const code = Number(rawCode);
      if (code === 21 || code === 58 ||
          (code === 4 && underlineStyle !== undefined && ![0, 1].includes(Number(underlineStyle)))) {
        // The serializer flattens extended underline styles and omits underline color. SGR0
        // only changes future text: already-painted cells and scrollback still need full replay.
        this.extendedSgr = true;
      } else if ((code === 38 || code === 48) && !attributes[i].includes(":")) {
        // Skip RGB / palette components so values such as 21 or 58 are not read as attributes.
        const count = attributes[i + 1] === "2" ? 4 : attributes[i + 1] === "5" ? 2 : 0;
        if (!count || i + count >= attributes.length ||
            attributes.slice(i + 1, i + count + 1).some(value => !/^\d*$/.test(value))) {
          this.extendedSgr = true; // ambiguous mixed color syntax also needs full replay
          return;
        }
        i += count;
      }
    }
  }

  capture(): string {
    if (this.parser !== "ground" || this.highSurrogate)
      throw new Error("Terminal output ends inside an escape or Unicode sequence");
    if (this.unsupported.size || this.statefulOsc || this.extendedSgr || this.terminal.modes.originMode)
      throw new Error("Terminal state requires full replay");
    // Restore into a clean terminal: otherwise disabled modes from an earlier attachment leak in.
    let ansi = "\x1bc" + this.serializer.serialize({ scrollback: 200 });
    for (const [mode, enabled] of this.modes) ansi += `\x1b[?${mode}${enabled ? "h" : "l"}`;
    ansi += this.cursorStyle;
    for (const [code, value] of this.titles) ansi += `\x1b]${code};${value}\x07`;
    if (Buffer.byteLength(ansi, "utf8") > 512 * 1024)
      throw new Error("Terminal snapshot exceeds its size limit");
    return ansi;
  }
}
