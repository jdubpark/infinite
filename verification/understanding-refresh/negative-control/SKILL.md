---
name: understanding-behavior
description: Use when authoring, reviewing, or checking a finite data-only behavior model for an Understanding component, including interpreting bounded safety results and optional TLC exports.
---

# Understanding behavior verification

Use this workflow when an Understanding behavior definition needs a local finite safety check or a separate TLC check.

1. Bind template IDs to the intended source snapshot, component, repository, and complete plan revision set. Keep current and planned models distinct.
2. From the suite directory, run the local checker and save its JSON result:

   ```sh
   infinite understand check --file definition.json --json > behavior-result.json
   ```

3. Review the checker version, model hash, timestamp, all four limits, exhaustive flag, and each property result. A counterexample is a safety failure. Treat inconclusive, incomplete, unreachable, unsupported, cancelled, timed-out, or otherwise bounded work as unresolved. Liveness is unsupported.
4. If independent checking is useful, run the exported current and planned TLA+ modules separately with TLC and record its version, commands, and results. Exporting a module does not mean TLC ran.

For model semantics and the Understanding refresh pilot, see `docs/behavior-verification.md` at the repository root. For a multi-repository model, bind the definition's repository ID to the repository containing the referenced host component code; A/B labels are symbolic workspace actors. The local checker verifies only the declared finite model; bind it to the intended preview and do not infer deployment or live source freshness from a pass.
