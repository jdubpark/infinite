---
name: understanding-behavior
description: Use when authoring, reviewing, or checking a finite data-only behavior model for an Understanding component, including interpreting bounded safety results and optional TLC exports.
---

# Understanding behavior verification

Use this workflow to turn a source-backed user flow into a reviewable statechart and a repeatable finite safety check.

## Create a definition

1. Read `infinite understand components --workspace WORKSPACE --json`, then `infinite understand component COMPONENT --workspace WORKSPACE --json` and `infinite understand catalog --workspace WORKSPACE --json`. Inspect the referenced source before making behavioral claims. Capture the component snapshot, repository ID, and complete active plan revision set.
2. Name the flow's actors, states, events, guards, finite variables, and transitions. Include concurrent actors and relevant failure, cancellation, retry, and restart paths. Current describes observed code; Planned describes recorded intent. Label invented requirements as proposed. Ask the owner only when an unresolved requirement changes the intended behavior.
3. Write `definition.json` using the types in `packages/remote/src/understanding-behavior.ts` and the pilot at `verification/understanding-refresh/definition.json`. Every transition and property needs an in-bounds source citation from the selected component. Use only the declared data predicates and simultaneous effects; model files never contain executable code. Record finite bounds, assumptions, and excluded actors explicitly.
4. Define safety properties from the requirements. Check that each property can be reached. Include a small negative control that deliberately breaks a guard or invariant so a passing check cannot hide missing coverage. Liveness and fairness need a separate supported verification tool; this checker reports them as unsupported.
5. Run the local check below. Translate counterexamples into ordered user-visible events and source references. Reproduce a consequential failure in a runtime regression before claiming the implementation is broken or fixed. Keep an old broken model explicitly labeled as a historical negative control.
6. Save the reviewed definition with `infinite understand behavior-save --workspace WORKSPACE --file definition.json --revision REVISION --request-id UUID`. Use revision zero for a new definition and the current behavior revision for an update. Reuse the same UUID and payload only for an uncertain retry. Start a host check explicitly with `infinite understand behavior-run BEHAVIOR --workspace WORKSPACE --revision REVISION --request-id UUID`.
7. Read the saved statechart, separate Current and Planned results, source freshness, and trace in Understanding. `infinite understand behavior-suite BEHAVIOR --workspace WORKSPACE --json` returns reusable suite files as data. Refresh and rebind changed source or plan inputs before running again; retain historical results as evidence for their original definition.

## Check a suite

1. Bind template IDs to the intended source snapshot, component, repository, and complete plan revision set. Keep current and planned models distinct.
2. From the suite directory, run the local checker and save its JSON result:

   ```sh
   infinite understand check --file definition.json --json > behavior-result.json
   ```

3. Review the checker version, model hash, timestamp, all four limits, exhaustive flag, and each property result. A counterexample is a safety failure. Treat inconclusive, incomplete, unreachable, unsupported, cancelled, timed-out, or otherwise bounded work as unresolved. Liveness is unsupported.
4. If independent checking is useful, run the exported current and planned TLA+ modules separately with TLC and record its version, commands, and results. Exporting a module does not mean TLC ran.

For model semantics and the Understanding refresh pilot, see `docs/behavior-verification.md` at the repository root. For a multi-repository model, bind the definition's repository ID to the repository containing the referenced host component code; A/B labels are symbolic workspace actors. The local checker verifies only the declared finite model; bind it to the intended preview and do not infer deployment or live source freshness from a pass.
