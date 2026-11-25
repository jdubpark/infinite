// Reads `infinite-metric NAME NUMBER` lines from a check's stdout.
// It works on raw bytes, so a chunk may end anywhere, even inside a CRLF or the marker.
// It is strict: it does not strip terminal escapes. It is separate from the failure scanner.
// Rule 12 is the caller's job: the caller keeps the values only when the check passed.

export type CheckMetricState = "value" | "ambiguous" | "invalid";
export interface CheckMetric { name: string; state: CheckMetricState; value?: number }
/** `more` counts the marker lines that named a name without a slot (rule 10). */
export interface CheckMetricScan { metrics: CheckMetric[]; more: number }

export const METRIC_MARKER = "infinite-metric ";
export const METRIC_LINE_MAX_BYTES = 200;
export const METRIC_NAMES_MAX = 8;

const LF = 0x0a;
const CR = 0x0d;
// Magnitude limit for a value. Infinity fails it too.
const VALUE_LIMIT = 1e15;
const NAME_PATTERN = "[a-z][a-z0-9_.-]{0,39}";
const NUMBER_PATTERN = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?";
const NAME = new RegExp(`^${NAME_PATTERN}$`);
// The regex only admits printable ASCII, so a valid line needs no separate byte check.
const LINE = new RegExp(`^infinite-metric (${NAME_PATTERN}) (${NUMBER_PATTERN})$`);

export class CheckMetricScanner {
  // The first 200 bytes of the current line. Bytes past that are counted, not kept.
  private readonly head = Buffer.alloc(METRIC_LINE_MAX_BYTES);
  // Content bytes of the current line. It stops at 201, which is enough to know the line is too long.
  private lineBytes = 0;
  // A CR was just read. It is dropped only if an LF follows it.
  private carriageReturn = false;
  private readonly slots = new Map<string, CheckMetric>();
  // Marker lines whose name has no slot. Counted per line: keeping the names would break the memory bound (rule 11).
  private unslotted = 0;
  // Set by a bad marker line whose name token is not a valid name. It makes every name invalid.
  private wholeInvalid = false;
  private result?: CheckMetricScan;

  push(chunk: Buffer, stream: "stdout" | "stderr"): void {
    if (this.result || stream !== "stdout") return;
    for (let i = 0; i < chunk.length; i++) this.byte(chunk[i]);
  }

  finish(): CheckMetricScan {
    if (this.result) return this.result;
    if (this.carriageReturn) {
      this.carriageReturn = false;
      this.add(CR);
    }
    if (this.lineBytes > 0) this.endLine();
    const metrics = [...this.slots.values()].map((slot): CheckMetric => {
      if (this.wholeInvalid || slot.state === "invalid") return { name: slot.name, state: "invalid" };
      if (slot.state === "ambiguous") return { name: slot.name, state: "ambiguous" };
      return { name: slot.name, state: "value", value: slot.value };
    });
    this.result = { metrics, more: this.unslotted };
    return this.result;
  }

  private byte(b: number): void {
    if (this.carriageReturn) {
      this.carriageReturn = false;
      if (b === LF) {
        this.endLine();
        return;
      }
      this.add(CR);
    }
    if (b === LF) this.endLine();
    else if (b === CR) this.carriageReturn = true;
    else this.add(b);
  }

  private add(b: number): void {
    if (this.lineBytes < METRIC_LINE_MAX_BYTES) this.head[this.lineBytes] = b;
    if (this.lineBytes <= METRIC_LINE_MAX_BYTES) this.lineBytes++;
  }

  private endLine(): void {
    const long = this.lineBytes > METRIC_LINE_MAX_BYTES;
    const text = this.head.toString("latin1", 0, Math.min(this.lineBytes, METRIC_LINE_MAX_BYTES));
    this.lineBytes = 0;
    if (!text.startsWith(METRIC_MARKER)) return;
    // The name token is the bytes after the marker up to the next space. A token cut by the 200-byte
    // limit is longer than any valid name, so it never matches.
    const token = text.slice(METRIC_MARKER.length).split(" ", 1)[0];
    const match = long ? null : LINE.exec(text);
    if (match) {
      const value = Number(match[2]);
      if (Math.abs(value) <= VALUE_LIMIT) {
        this.valid(match[1], value === 0 ? 0 : value);
        return;
      }
    }
    if (NAME.test(token)) this.invalid(token);
    else this.wholeInvalid = true;
  }

  private valid(name: string, value: number): void {
    const slot = this.slotFor(name);
    if (!slot || slot.state !== "value") return;
    if (slot.value === undefined) slot.value = value;
    else if (slot.value !== value) {
      slot.state = "ambiguous";
      slot.value = undefined;
    }
  }

  private invalid(name: string): void {
    const slot = this.slotFor(name);
    if (!slot) return;
    slot.state = "invalid";
    slot.value = undefined;
  }

  // The first 8 distinct names take a slot, whether their line was valid or not.
  private slotFor(name: string): CheckMetric | undefined {
    const found = this.slots.get(name);
    if (found) return found;
    if (this.slots.size < METRIC_NAMES_MAX) {
      const slot: CheckMetric = { name, state: "value" };
      this.slots.set(name, slot);
      return slot;
    }
    if (this.unslotted < Number.MAX_SAFE_INTEGER) this.unslotted++;
    return undefined;
  }
}
