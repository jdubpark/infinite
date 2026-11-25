export type SudoShape =
  | { ok: true; options: string[]; executable: string; providerArgs: string[] }
  | { ok: false; problem: "wrapper" | "executable" };

export function sudoShape(args: readonly string[]): SudoShape {
  const sudoBoundary = args.indexOf("--");
  if (sudoBoundary < 0) return { ok: false, problem: "wrapper" };
  for (let index = 0; index < sudoBoundary; index++) {
    const arg = args[index];
    if (["-n", "-H", "--non-interactive", "--set-home"].includes(arg)) continue;
    if (["-u", "-g", "--user", "--group"].includes(arg)) {
      const value = args[++index];
      if (index < sudoBoundary && value && !value.startsWith("-")) continue;
    }
    return { ok: false, problem: "wrapper" };
  }
  const executable = args[sudoBoundary + 1];
  if (!executable || executable.startsWith("-")) return { ok: false, problem: "executable" };
  return { ok: true, options: args.slice(0, sudoBoundary), executable, providerArgs: args.slice(sudoBoundary + 2) };
}
