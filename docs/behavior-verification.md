# Finite behavior verification

Infinite can check a bounded, data-only state machine for safety properties. The checker is an explicit-state breadth-first search; it does not execute model strings, JavaScript, shell commands, or generated TLA+ expressions. Its result describes the declared model and limits, not whether a workspace, provider, or deployment is live and correct.

## Model and result semantics

A model declares finite control states, finite-domain variables, guarded transitions, and properties. A transition's guard reads the current valuation. Every assignment in its effects also reads that same old valuation, so a multi-variable transition is simultaneous. The checker explores each enabled transition from each reachable state, stores predecessor links, and evaluates safety properties at the initial state and each newly reached successor.

A property may apply to every state or to a declared subset of control states. The checker counts reachable states in that scope separately from whether the predicate holds. If no state in scope is reachable, the property is `unreachable` and the aggregate result is inconclusive; this prevents a vacuous pass. Liveness properties are `unsupported` and also make the aggregate result inconclusive.

The checker returns the shortest safety counterexample found by BFS. Its trace limit bounds emitted steps while preserving the trace endpoints and marking omitted middle steps. A counterexample remains a failure when its displayed trace is truncated. A state or transition limit, deadline, abort, unreachable property, or unsupported liveness property never yields a pass. Invalid definitions and models throw readable validation errors.

Defaults are 50,000 states, 250,000 evaluated transitions, 30 seconds, and 100 trace steps. Callers may lower or raise the limits within caps of 50,000 states, 500,000 transitions, 300 seconds, and 10,000 trace steps. The schema also caps individual models at 256 control states, 64 variables, 128 values per domain, 4,096 transitions, 128 properties, and bounded predicate depth and node counts. The result records the checker version, canonical model hash, complete limits, timestamp, exhaustive flag, explored counts, and per-property result.

`validateBehaviorDefinition(value)` strictly validates and normalizes a definition. `behaviorDefinitionHash(definition)` computes a stable SHA-256 over that normalized data. `checkBehaviorModel(model, options?)` independently validates and searches a model. It yields to the host event loop periodically; cancellation and deadlines return inconclusive results. Invalid input never turns into a passing result.

Behavior, state, variable, transition, and property IDs follow the host's letter-leading identifier contract. Scope IDs such as repository IDs, component IDs, plan IDs, and source snapshot hashes may begin with a digit, so UUID and SHA-256 forms are accepted while paths, controls, and unsupported punctuation remain rejected.

The host retains encrypted definitions and up to eight runs per behavior within a 4 MiB workspace store. Mutations that exceed this capacity are rejected without invalidating saved state. Every running admission reserves space for a terminal receipt. If checker output cannot fit, that run finishes with an explicit storage-limit error and no retained result; earlier runs remain readable and the admission remains consumed. A new explicit request can check a smaller model.

## Suites and TLC exports

`exportBehaviorSuite(definition)` returns data files rather than writing them. A suite includes `definition.json`, a human README, a reusable skill, and separate `Current.tla`/`.cfg` and optional `Planned.tla`/`.cfg` exports. Identifiers are generated from safe names. Domain values become finite integer ordinals, so arbitrary definition text is not interpolated as TLA+ code. The export checks only declared safety invariants and does not encode the local checker's liveness result. Creating an export does not run TLC.

Run a bound suite from its directory:

```sh
infinite understand check --file definition.json --json > behavior-result.json
```

Before running it, replace template source snapshot, component, repository, and complete plan revision identifiers with the preview's actual scope. For a multi-repository model, bind `repositoryId` to the repository containing the referenced host component code; model labels such as A and B are symbolic workspace actors. Keep evidence repository IDs scoped to that host-code repository. Review current and planned independently. Retain the result's checker version, model hash, timestamp, limits, exhaustive flag, property statuses, and counterexample traces. A `passed` result applies only to that finite bound model.

## Understanding refresh pilot

`verification/understanding-refresh/definition.json` models two hooked repositories with one synthesized component each. The Current model follows the runtime sequence: capture source and plans, accept each bounded writer result, await and recheck each repository's source context, then synchronously compare every covered component's plan revisions against the captured set before the publication membership check. The per-repository context awaits are at [understanding-runtime.ts:425](../packages/host/src/understanding-runtime.ts:425); the source fingerprint check is at [understanding-runtime.ts:427](../packages/host/src/understanding-runtime.ts:427); the final workspace plan fence and publication are at [understanding-runtime.ts:432](../packages/host/src/understanding-runtime.ts:432) and [understanding-runtime.ts:444](../packages/host/src/understanding-runtime.ts:444).

The model permits an event-loop catalog edit to repository A while repository B's context call is pending. The final all-repository plan fence rejects publication after that edit. Planned names this fence as its own state to make the intended stage explicit. A/B are symbolic workspace repository roles; all source evidence belongs to the host repository containing `understanding-runtime.ts`. Both models check that a published candidate retains the source fingerprints used by its accepted writer input; neither claims that the live checkout cannot change after a filesystem read. External filesystem writes are modeled separately from host catalog edits, including writes after the final host check and after publication. There is no atomic checkout lock, so a passing result is not proof of live source freshness.

The regression scenario is recorded in [understanding-runtime.test.ts:175](../tests/understanding-runtime.test.ts:175). It reproduces the former ordering: repository A passed its plan check, repository B then awaited context, and a catalog edit changed A before publication. The negative control at `verification/understanding-refresh/negative-control/definition.json` deliberately restores that ordering. Its shortest checker trace is:

```text
admit_and_capture
complete_synthesis_a
complete_synthesis_b
repo_a_source_and_plan_check
begin_repo_b_context_await
edit_repo_a_plan_during_repo_b_context
repo_b_context_and_plan_check
publish_after_repo_b_context_without_workspace_fence
```

The corrected Current model passed with 17 states and 32 transitions. Planned passed with 21 states and 40 transitions. The negative control returned a counterexample after exploring 17 states and 30 transitions; its shortest trace has nine states (eight transitions). Each declared property was reachable in two publication states for the passing models.

## Independent TLC run

The TLA+ files were checked with the official `tlaplus/tlaplus` v1.7.4 release; the bundled TLC reports version 2.19. TLC's official documentation describes it as an explicit-state model checker that checks safety and liveness properties ([TLA+ tools](https://lamport.azurewebsites.net/tla/tools.html), [v1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)). The suite export intentionally contains only safety invariants.

The artifact was kept in ignored `.local/tools/tla2tools-1.7.4.jar`; metadata files were kept under ignored `.local/tlc/`. From the repository root, these were the commands:

```sh
java -XX:+UseParallelGC -cp .local/tools/tla2tools-1.7.4.jar tlc2.TLC -config verification/understanding-refresh/verification/Current.cfg -metadir .local/tlc/understanding-current-final verification/understanding-refresh/verification/Current.tla
java -XX:+UseParallelGC -cp .local/tools/tla2tools-1.7.4.jar tlc2.TLC -config verification/understanding-refresh/verification/Planned.cfg -metadir .local/tlc/understanding-planned-final verification/understanding-refresh/verification/Planned.tla
java -XX:+UseParallelGC -cp .local/tools/tla2tools-1.7.4.jar tlc2.TLC -config verification/understanding-refresh/negative-control/verification/Current.cfg -metadir .local/tlc/understanding-negative-final verification/understanding-refresh/negative-control/verification/Current.tla
```

Current completed without invariant errors with 17 distinct states (19 generated); Planned completed without invariant errors with 21 distinct states (25 generated). The negative control violated the exported invariant for `published_plans_match_captured_revisions` after eight transitions (nine trace states), after the repository A plan edit and the second repository's context check. TLC stopped at that counterexample with states remaining in its queue, as expected for a failing model. This independent check validates the generated finite TLA+ semantics, not the runtime implementation or the external filesystem assumptions.

## Scope and references

The pilot covers the two-repository interleaving that exposed the earlier plan-fence gap. It does not prove behavior for every workspace size, provider response, writer output, process crash, filesystem mutation timing, deployment, or owner acceptance. Keep those claims separate from the finite model result.

For TLA+ syntax and model-checking workflow, use the primary [TLA+ tools guide](https://lamport.azurewebsites.net/tla/tools.html) and the official [TLA+ examples](https://github.com/tlaplus/Examples). The generator's output must be run independently with TLC before describing it as TLC-checked.
