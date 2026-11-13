import test from "node:test";
import assert from "node:assert/strict";
import {
  featureMapDigest,
  featureMapSchema,
  isDocPath,
  isTestPath,
  pathArea,
  taskArea,
  taskFeatures,
  taskRisk,
  votingPaths,
  type FeatureMap,
} from "../packages/host/src/task-features.js";

test("a path takes the area of its longest mapped prefix", () => {
  const map: FeatureMap = {
    areas: [
      { id: "host", paths: ["packages/host"] },
      { id: "host-teams", paths: ["packages/host/src/teams.ts", "packages/host/src/team-types.ts"] },
    ],
  };
  assert.equal(pathArea("packages/host/src/teams.ts", map), "host-teams");
  assert.equal(pathArea("packages/host/src/usage.ts", map), "host");

  const tied: FeatureMap = {
    areas: [
      { id: "first", paths: ["lib/shared"] },
      { id: "second", paths: ["lib/shared"] },
    ],
  };
  assert.equal(pathArea("lib/shared/a.ts", tied), "first");

  const everything: FeatureMap = { areas: [{ id: "all", paths: ["."] }] };
  assert.equal(pathArea("any/where/file.ts", everything), "all");
  assert.equal(pathArea("top.ts", everything), "all");
});

test("an unmapped path falls back to its leading segments", () => {
  assert.equal(pathArea("packages/host/src/usage.ts"), "packages/host/");
  assert.equal(pathArea("apps/mobile/src/api/client.ts"), "apps/mobile/");
  assert.equal(pathArea("packages/README.md"), "packages/");
  assert.equal(pathArea("scripts/run-tests.mjs"), "scripts/");
  assert.equal(pathArea("README.md"), "root");
  assert.equal(pathArea("Docs/Guide/intro.txt"), "Docs/");
});

test("test and doc paths do not vote unless nothing else is owned", () => {
  assert.equal(taskArea(["packages/host/src/usage.ts", "tests/usage.test.ts", "docs/teams.md"]), "packages/host/");
  assert.equal(taskArea(["tests/usage.test.ts"]), "tests/");
  assert.equal(taskArea(["docs/teams.md", "tests/a.test.ts"]), "mixed");

  assert.deepEqual(
    votingPaths(["packages/host/src/usage.ts", "tests/usage.test.ts", "docs/teams.md"]),
    ["packages/host/src/usage.ts"],
  );
  assert.deepEqual(votingPaths(["tests/usage.test.ts"]), ["tests/usage.test.ts"]);
  assert.deepEqual(votingPaths(["docs/teams.md", "tests/a.test.ts"]), ["docs/teams.md", "tests/a.test.ts"]);

  assert.equal(isTestPath("tests/usage.test.ts"), true);
  assert.equal(isTestPath("packages/host/src/__tests__/x.ts"), true);
  assert.equal(isTestPath("packages/host/src/author.ts"), false);
  assert.equal(isDocPath("docs/teams.md"), true);
  assert.equal(isDocPath("packages/README.md"), true);
  assert.equal(isDocPath("packages/host/src/teams.ts"), false);
});

test("a task over two areas is mixed", () => {
  assert.equal(taskArea(["packages/host/src/a.ts", "apps/web/src/b.ts"]), "mixed");
  assert.equal(taskArea([]), "mixed");
});

test("risk rises on a token, a prefix, or a label", () => {
  assert.equal(taskRisk(["packages/host/src/auth/session.ts"]), "elevated");
  assert.equal(taskRisk(["packages/host/src/author.ts"]), "normal");
  assert.equal(taskRisk(["deploy/ubuntu/infinite.sudoers"]), "elevated");
  assert.equal(taskRisk([".github/workflows/ci.yml"]), "elevated");
  assert.equal(taskRisk(["packages/host/src/Permissions.ts"]), "elevated");

  // An explicit prefix elevates a neutral file. Without the prefix the same file is normal.
  const neutral: FeatureMap = { areas: [{ id: "src", paths: ["src"] }], elevated: ["src/runtime.ts"] };
  assert.equal(taskRisk(["src/runtime.ts"]), "normal");
  assert.equal(taskRisk(["src/runtime.ts"], neutral), "elevated");

  for (const path of [
    "src/oauthClient.ts",
    "src/PaymentsService.ts",
    "src/authorization.ts",
    "src/authentication.ts",
    "db/migrate/001.sql",
    "infra/terraform/main.tf",
    ".env",
    "Dockerfile",
    "k8s/service.yaml",
    ".gitlab-ci.yml",
    "packages/host/src/deployment.ts",
    // Capital and digit forms.
    "src/K8sClient.ts",
    "K8S/service.yaml",
    "src/k8sClient.ts",
    "src/OAuth2Client.ts",
    "src/AUTHService.ts",
    "build/DockerFile",
    "src/DockerFileBuilder.ts",
    "src/K8S2Client.ts",
    "src/authV2Handler.ts",
    // A plural matches its singular.
    "src/authorizations.ts",
    "src/authentications.ts",
    "src/permissions.ts",
    "infra/envs/prod.ts",
  ]) {
    assert.equal(taskRisk([path]), "elevated", path);
  }
  for (const path of [
    "packages/host/src/author.ts",
    "src/environment.ts",
    "src/cinema.ts",
    "src/cinemas.ts",
    "src/authors.ts",
    "src/classes.ts",
  ]) {
    assert.equal(taskRisk([path]), "normal", path);
  }

  const byPrefix: FeatureMap = {
    areas: [{ id: "host", paths: ["packages/host"] }],
    elevated: ["packages/host/src/vault.ts"],
  };
  assert.equal(taskRisk(["packages/host/src/vault.ts"], byPrefix), "elevated");

  const byToken: FeatureMap = {
    areas: [{ id: "src", paths: ["src"] }],
    elevatedTokens: ["ledger"],
  };
  assert.equal(taskRisk(["src/auth.ts"], byToken), "normal");
  assert.equal(taskRisk(["src/ledger.ts"], byToken), "elevated");
  assert.equal(taskRisk(["src/ledgers.ts"], byToken), "elevated");
  // A project entry is spelled across adjacent words, as a default entry is.
  const compound: FeatureMap = { areas: [], elevatedTokens: ["oauth", "s3"] };
  assert.equal(taskRisk(["src/OAuthClient.ts"], compound), "elevated");
  assert.equal(taskRisk(["src/S3Bucket.ts"], compound), "elevated");
  assert.equal(taskRisk(["src/Client.ts"], compound), "normal");

  assert.equal(taskRisk(["packages/host/src/usage.ts"], undefined, "elevated"), "elevated");
});

test("a token needs a word boundary", () => {
  // A separator, a camel-case boundary, or a letter-digit boundary marks a word.
  for (const path of ["src/authService.ts", "src/auth_service.ts", "src/auth-service.ts", "src/k8sClient.go", "src/auth2.ts"]) {
    assert.equal(taskRisk([path]), "elevated", path);
  }
  // Nothing marks a boundary inside a lower-case compound, and a separator ends a name.
  for (const path of ["src/authservice.ts", "src/k8sclient.go", "src/per-mission-budget.ts", "src/reauth.ts"]) {
    assert.equal(taskRisk([path]), "normal", path);
  }
  // A very long name is still read. Only a run longer than an entry is skipped.
  assert.equal(taskRisk([`src/${"Ab".repeat(600)}Auth.ts`]), "elevated");
  assert.equal(taskRisk([`src/${"a".repeat(3000)}.ts`]), "normal");
});

test("an explicit elevated prefix applies to every owned path", () => {
  const map: FeatureMap = { areas: [{ id: "src", paths: ["src"] }], elevated: ["docs/deploy"] };
  const paths = ["src/ui.ts", "docs/deploy/run.sh"];
  assert.equal(taskRisk(paths, map), "elevated");
  assert.equal(taskRisk(paths), "normal");
});

test("a prefix matches whole segments only", () => {
  const map: FeatureMap = { areas: [{ id: "src", paths: ["src"] }], elevated: ["src"] };
  assert.equal(pathArea("src/a.ts", map), "src");
  assert.equal(pathArea("src2/a.ts", map), "src2/");
  assert.equal(taskRisk(["src/a.ts"], map), "elevated");
  assert.equal(taskRisk(["src2/a.ts"], map), "normal");
});

test("malformed paths never throw and reserved directory names do not collide", () => {
  assert.equal(pathArea("none/a.ts"), "none/");
  assert.equal(pathArea("mixed/a.ts"), "mixed/");
  assert.equal(pathArea("root/a.ts"), "root/");
  for (const path of ["", "/src/x.ts", "./src/x.ts", "a//b.ts", "a\\b.ts"]) {
    assert.equal(pathArea(path), "root", JSON.stringify(path));
  }
});

test("a test path alone does not raise risk for a task that owns source", () => {
  assert.equal(taskRisk(["packages/host/src/usage.ts", "tests/auth.test.ts"]), "normal");
  assert.equal(taskRisk(["tests/auth.test.ts"]), "elevated");
});

test("task features combine the rules", () => {
  const fix = taskFeatures({ role: "implementer", paths: ["packages/host/src/usage.ts"], kind: "fix" });
  assert.equal(fix.kind, "fix");
  assert.equal(fix.role, "implementer");
  assert.equal(fix.area, "packages/host/");
  assert.equal(fix.featureVersion, 1);
  assert.equal(fix.featureMap, "default");

  const unlabeled = taskFeatures({ role: "implementer", paths: ["packages/host/src/usage.ts"] });
  assert.equal(unlabeled.kind, null);

  const scout = taskFeatures({ role: "scout", paths: ["packages/host/src/usage.ts"] });
  assert.equal(scout.area, "none");
  assert.equal(scout.kind, "investigation");

  // Risk for each role, once normal and once elevated.
  assert.equal(taskFeatures({ role: "implementer", paths: ["packages/host/src/usage.ts"] }).risk, "normal");
  assert.equal(
    taskFeatures({ role: "implementer", paths: ["packages/host/src/usage.ts"], risk: "elevated" }).risk,
    "elevated",
  );
  assert.equal(taskFeatures({ role: "scout", paths: ["packages/host/src/usage.ts"] }).risk, "normal");
  assert.equal(taskFeatures({ role: "scout", paths: ["packages/host/src/auth.ts"] }).risk, "elevated");

  const mapped = taskFeatures(
    { role: "implementer", paths: ["packages/host/src/usage.ts"], kind: "feature" },
    { areas: [{ id: "usage", paths: ["packages/host/src/usage.ts"] }] },
  );
  assert.equal(mapped.area, "usage");
  assert.match(mapped.featureMap, /^[0-9a-f]{64}$/);
});

test("the feature map digest is stable", () => {
  const first = {
    areas: [{ id: "host", paths: ["packages/host"] }],
    elevated: ["packages/host/src/vault.ts"],
  } as FeatureMap;
  const reordered = {
    elevated: ["packages/host/src/vault.ts"],
    areas: [{ paths: ["packages/host"], id: "host" }],
  } as FeatureMap;
  assert.equal(featureMapDigest(first), featureMapDigest(reordered));

  const changed: FeatureMap = {
    areas: [{ id: "host", paths: ["packages/host/src"] }],
    elevated: ["packages/host/src/vault.ts"],
  };
  assert.notEqual(featureMapDigest(first), featureMapDigest(changed));
  assert.equal(featureMapDigest(), "default");

  // Array order is kept, so swapping two areas changes the digest.
  const a = { id: "a", paths: ["a"] };
  const b = { id: "b", paths: ["b"] };
  assert.notEqual(featureMapDigest({ areas: [a, b] }), featureMapDigest({ areas: [b, a] }));

  // An undefined key digests like an absent key.
  const absent = { areas: [a] } as FeatureMap;
  const undefinedKey = { areas: [a], elevated: undefined } as unknown as FeatureMap;
  assert.equal(featureMapDigest(absent), featureMapDigest(undefinedKey));
});

test("the feature map schema refuses bad maps", () => {
  const valid = { areas: [{ id: "host", paths: ["packages/host"] }] };
  assert.equal(featureMapSchema.safeParse(valid).success, true);
  assert.equal(
    featureMapSchema.safeParse({ ...valid, elevatedTokens: ["ledger"], elevated: ["packages/host/src/vault.ts"] }).success,
    true,
  );
  // The single prefix `.` is the match-all prefix, and it is valid.
  assert.equal(featureMapSchema.safeParse({ areas: [{ id: "all", paths: ["."] }] }).success, true);

  const refused: unknown[] = [
    { areas: [{ id: "mixed", paths: ["packages/host"] }] },
    { areas: [{ id: "host", paths: ["a"] }, { id: "host", paths: ["b"] }] },
    { areas: [{ id: "Host", paths: ["packages/host"] }] },
    { areas: [{ id: "host", paths: ["packages/../secrets"] }] },
    { areas: [{ id: "host", paths: ["/packages/host"] }] },
    { areas: [{ id: "infra", paths: ["./infra"] }] },
    { areas: [{ id: "infra", paths: ["infra//terraform"] }] },
    { areas: [{ id: "infra", paths: ["infra/./terraform"] }] },
    { areas: [{ id: "host", paths: ["packages/host"] }], elevatedTokens: ["two-words"] },
    { areas: [{ id: "host", paths: ["packages/host"] }], unknownKey: true },
  ];
  for (const map of refused) {
    assert.equal(featureMapSchema.safeParse(map).success, false, JSON.stringify(map));
  }
  // A project may set only risk rules. An empty area list is valid.
  assert.equal(featureMapSchema.safeParse({ areas: [], elevated: ["packages/host/src/vault.ts"] }).success, true);
});
