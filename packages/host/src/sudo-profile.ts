// Reads a sudo provider profile's arguments. Node built-ins only, so the drain process can share it.
export type SudoShape =
  | { ok: true; options: string[]; executable: string; providerArgs: string[] }
  | { ok: false; problem: "wrapper" | "executable" };

/**
 * Reads the arguments of a sudo provider profile. Before `--` only -n, --non-interactive, -H, --set-home,
 * -u USER, --user USER, -g GROUP, and --group GROUP are allowed. After it comes the executable.
 */
export function sudoShape(args: readonly string[]): SudoShape {
  const sudoBoundary = args.indexOf("--");
  if (sudoBoundary < 0) return { ok: false, problem: "wrapper" };
  // Recognize the supported wrapper instead of mistaking a provider's -- for sudo's.
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
