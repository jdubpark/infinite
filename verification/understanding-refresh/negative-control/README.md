# Understanding refresh old per-repository ordering negative control

This suite describes a bounded finite behavior model for "TEMPLATE_COMPONENT_BIND_BEFORE_USE" / "TEMPLATE_HOST_REPOSITORY_BIND_BEFORE_USE" / "TEMPLATE_SOURCE_SNAPSHOT_BIND_BEFORE_USE". The definition is a template until the preview is bound to its actual source snapshot, component, repository, and complete plan revision set. For a multi-repository model, bind the repository ID to the repository containing the referenced host component code; labels such as A and B represent workspace actors, not source-evidence ownership.

Current model: finite safety specification; run the command below to produce a result. Planned model: none is declared.

## Current, Planned, and Difference

Current and planned are complete independent model definitions. Compare their states, domains, transitions, and safety properties directly; a pass for either model does not imply equivalence or approval of the other.

## Run

    infinite understand check --file definition.json --json

The checker exhaustively explores enabled transitions within the recorded state, transition, time, and trace limits. A result passes only when all declared reachable safety properties are checked exhaustively. Liveness is unsupported; unreachable properties and every incomplete run remain inconclusive.

The verification exports represent current and planned models independently. TLC has not been run by exporting these files. When an independent TLC run is performed, record the TLC version, exact command, and result alongside the review. See [Lamport's TLA+ tools](https://lamport.azurewebsites.net/tla/tools.html) and the [TLA+ examples](https://github.com/tlaplus/Examples).

## Assumptions

- The finite pilot selects two hooked repositories from one workspace to expose the cross-repository await ordering.
- Plan edits are host catalog operations and may interleave while a synthesis or context adapter is awaited.
- The final synchronous plan read and publication have no intervening event-loop await.
- Model values 0 and 1 are symbolic tokens for same-as-captured and changed observations, not actual source hashes or plan revision numbers.

## Exclusions

- External filesystem writes are an independent actor and can race a context scan or occur after the final fingerprint read.
- The source invariant checks that candidate metadata retains its captured fingerprint; it does not prove live checkout freshness at publication.
- Provider truth, deployment, owner acceptance, and other workspace sizes are outside this model.

Bind template source, component, repository, and plan revision identifiers to the intended preview before treating a result as relevant. A source map or passing model does not establish deployment or live acceptance.
