# Self-hosted Honcho qualification

This compose file pins the Honcho API image and its PostgreSQL/Redis dependencies by digest. It uses private Docker networking, loopback-only API publishing, authentication, disabled message embedding, reasoning, summary, dream, telemetry, and memory-backed service data. The qualification runner creates short-lived synthetic credentials and tears down only its uniquely named Compose project.

Run `./qualify-honcho.sh` with Docker Compose available. The check creates synthetic workspaces with workspace-scoped JWTs, stores and keyword-searches a synthetic message with embedding disabled, confirms cross-workspace results and expired/absent credentials are denied, rebuilds the projection into an empty replacement workspace, and records asynchronous deletion acceptance. A `202` response does not prove deletion cleanup completed.

The checked Honcho `v3.4.0` image is AGPL-3.0. Distribution and hosted-use obligations have not had legal review. The runtime adapter reports the API as degraded and blocks provider ingestion and semantic search. Honcho's message route can schedule internal embedding/reasoning work and retries unless embedding and reasoning features are disabled. The compose network has no outbound route, disables those features, and uses only a dummy model key. Do not enable model traffic until a controlled egress proxy durably meters every provider attempt and the deployment/license review is complete.

This slice qualifies API authentication, partition isolation, deterministic keyword behavior with all inference disabled, and empty-workspace rebuild mechanics. It does not establish semantic recall, inference-provider compatibility, physical deletion completion, latency/scale, backup/restore, or production adoption.
