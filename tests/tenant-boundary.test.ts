import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import { createApp } from "../packages/host/src/server.js";
import { hashToken, readConfig } from "../packages/host/src/config.js";
import { workerCall } from "../packages/host/src/ipc.js";
import { planFleet } from "../packages/host/src/fleet.js";
import type { Config } from "../packages/host/src/types.js";

test(
  "separate tenant runners deny each other's keys, context and recordings",
  { timeout: 20000 },
  async () => {
    const root = mkdtempSync("/tmp/inf-tenants-");
    const servers: Server[] = [];
    const workers: { config: Config; id: string }[] = [];
    const makeTenant = async (name: string) => {
      const base = join(root, name);
      mkdirSync(join(base, "workspace"), { recursive: true });
      const token = randomBytes(32).toString("base64url");
      const config: Config = {
        deployment: { mode: "tenant-development", tenantId: randomUUID() },
        port: 0,
        origin: "http://127.0.0.1",
        stateDir: join(base, "state"),
        runDir: join(base, "run"),
        keyFile: join(base, "key"),
        environment: "local",
        enableDemo: true,
        maxSessions: 10,
        tokens: [
          { id: name, label: name, role: "owner", hash: hashToken(token) },
        ],
        projects: [
          { id: "workspace", name: "Workspace", path: join(base, "workspace") },
        ],
        agents: {
          demo: {
            command: process.execPath,
            args: [
              "--import",
              import.meta.resolve("tsx"),
              resolve("packages/host/src/demo.ts"),
            ],
          },
        },
      };
      writeFileSync(config.keyFile, randomBytes(32), { mode: 0o600 });
      const file = join(base, "config.json");
      writeFileSync(file, JSON.stringify(config));
      const parsed = readConfig(file);
      const { app } = createApp(parsed.config, parsed.key);
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      parsed.config.port = (server.address() as { port: number }).port;
      const request = async (
        path: string,
        body?: unknown,
        key = token,
        method = body ? "POST" : "GET",
      ) => {
        const response = await fetch(
          `http://127.0.0.1:${parsed.config.port}/api${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
          },
        );
        return { status: response.status, body: await response.json() };
      };
      return { config: parsed.config, token, request, file };
    };
    try {
      const a = await makeTenant("a");
      const b = await makeTenant("b");
      assert.equal(
        (await b.request("/sessions", undefined, a.token)).status,
        401,
      );
      assert.equal(
        (await a.request("/sessions", undefined, b.token)).status,
        401,
      );
      for (const [tenant, name] of [
        [a, "A"],
        [b, "B"],
      ] as const) {
        assert.equal(
          (
            await tenant.request(
              "/projects/workspace/context",
              { text: `${name} synthetic context`, expectedVersion: 0 },
              tenant.token,
              "PUT",
            )
          ).status,
          200,
        );
        const created = await tenant.request("/sessions", {
          requestId: randomUUID(),
          provider: "demo",
          projectId: "workspace",
          title: `${name} recording`,
          prompt: `${name} synthetic prompt`,
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.context, `${name} synthetic context`);
        workers.push({ config: tenant.config, id: created.body.id });
      }
      assert.deepEqual(
        (await a.request("/sessions")).body.sessions.map(
          (s: { title: string }) => s.title,
        ),
        ["A recording"],
      );
      assert.deepEqual(
        (await b.request("/sessions")).body.sessions.map(
          (s: { title: string }) => s.title,
        ),
        ["B recording"],
      );
      for (const suffix of ["", "/events"]) {
        assert.equal(
          (await a.request(`/sessions/${workers[1].id}${suffix}`)).status,
          404,
        );
        assert.equal(
          (await b.request(`/sessions/${workers[0].id}${suffix}`)).status,
          404,
        );
      }
      assert.equal(
        (
          await a.request(`/sessions/${workers[1].id}/input`, {
            requestId: randomUUID(),
            text: "cross-tenant write",
            submit: true,
          })
        ).status,
        404,
      );
      assert.equal(
        (await b.request("/projects/workspace/context")).body.text,
        "B synthetic context",
      );
      const security = (await a.request("/me")).body.security;
      assert.equal(security.operatorConfidential, false);
      assert.equal(security.tenancy, "multi-tenant");
      assert.equal(security.isolation, "external-vm-required");
      assert.equal(
        (
          await a.request("/sessions", {
            requestId: randomUUID(),
            provider: "claude",
            projectId: "workspace",
            title: "Not a rehearsal",
            prompt: "",
          })
        ).status,
        409,
      );

      const config = JSON.parse(readFileSync(a.file, "utf8"));
      config.agents.claude = { command: "claude", args: [] };
      writeFileSync(a.file, JSON.stringify(config));
      assert.throws(() => readConfig(a.file), /only the rehearsal provider/);
      delete config.agents.claude;
      config.deployment.mode = "confidential";
      writeFileSync(a.file, JSON.stringify(config));
      assert.throws(() => readConfig(a.file), /no attestation/);
    } finally {
      for (const worker of workers) {
        try {
          await workerCall(worker.config.runDir, worker.id, {
            op: "stop",
            requestId: randomUUID(),
          });
        } catch {}
      }
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 1700));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("single-tenant initialization permits native agents without a tenant or VM requirement", () => {
  const root = mkdtempSync("/tmp/inf-single-");
  try {
    const file = join(root, "config.json");
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/host/src/cli.ts",
        "init",
        "--config",
        file,
        "--origin",
        "https://runner.example",
        "--deployment-mode",
        "single-tenant",
        "--state-dir",
        join(root, "state"),
        "--run-dir",
        join(root, "run"),
        "--project",
        join(root, "workspace"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const { config } = readConfig(file);
    assert.equal(config.deployment?.mode, "single-tenant");
    assert.equal(config.enableDemo, false);
    assert.ok(
      config.agents.claude &&
        config.agents.codex &&
        config.agents.grok &&
        config.agents.opencode,
    );
    // Preserve early personal-mode configurations as the direct single-tenant mode.
    writeFileSync(
      file,
      JSON.stringify({ ...config, deployment: { mode: "personal" } }),
    );
    assert.equal(readConfig(file).config.deployment?.mode, "single-tenant");
    // A launcher such as sudo or a runtime needs its configured arguments too.
    const executable = join(root, "version-fixture.cjs");
    writeFileSync(
      executable,
      'if (process.argv[2] !== "--version") process.exit(2); console.log("Fixture Agent 7.0");',
    );
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        agents: { codex: { command: process.execPath, args: [executable] } },
      }),
    );
    const doctor = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/host/src/cli.ts",
        "doctor",
        "--config",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /codex: Fixture Agent 7\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("confidential initialization refuses before generating keys or configuration", () => {
  const root = mkdtempSync("/tmp/inf-policy-");
  try {
    const config = join(root, "new", "config.json");
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/host/src/cli.ts",
        "init",
        "--config",
        config,
        "--origin",
        "https://runner.example",
        "--deployment-mode",
        "confidential",
        "--tenant-id",
        randomUUID(),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /no attestation/);
    assert.equal(existsSync(join(root, "new")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fleet planning refuses private data, identity collisions, secret fields and overcommit", () => {
  const fixture = JSON.parse(
    readFileSync("deploy/proxmox/fleet.example.json", "utf8"),
  );
  const plan = planFleet(fixture);
  assert.equal(plan.memory.guestsMiB, 32768);
  assert.equal(plan.memory.unallocatedMiB, 24576);
  assert.equal(plan.vcpus, 8);
  assert.equal(plan.disksGiB, 320);
  const cases: [string, (value: any) => void, RegExp][] = [
    [
      "private data",
      (value) => {
        value.tenants[0].dataClass = "private";
      },
      /Private workloads are blocked/,
    ],
    [
      "tenant collision",
      (value) => {
        value.tenants[1].tenantId = value.tenants[0].tenantId;
      },
      /unique tenantId/,
    ],
    [
      "case-insensitive tenant collision",
      (value) => {
        value.tenants[1].tenantId = value.tenants[0].tenantId.toUpperCase();
      },
      /unique tenantId/,
    ],
    [
      "VM collision",
      (value) => {
        value.tenants[1].vmId = value.tenants[0].vmId;
      },
      /unique vmId/,
    ],
    [
      "IP collision",
      (value) => {
        value.tenants[1].ipv4 = value.tenants[0].ipv4;
      },
      /unique ipv4/,
    ],
    [
      "memory",
      (value) => {
        value.tenants[0].memoryMiB = 65536;
      },
      /memory exceeds/,
    ],
    [
      "CPU",
      (value) => {
        value.tenants[0].vcpus = 12;
      },
      /vCPUs exceed/,
    ],
    [
      "disk",
      (value) => {
        value.tenants[0].diskGiB = 600;
      },
      /disks exceed/,
    ],
    [
      "credentials",
      (value) => {
        value.tenants[0].providerApiKey = "must-not-enter-control-plane";
      },
      /Unrecognized key/,
    ],
    [
      "self-asserted protection",
      (value) => {
        value.operatorConfidential = true;
      },
      /Unrecognized key/,
    ],
  ];
  for (const [name, mutate, reason] of cases) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => planFleet(changed), reason, name);
  }
});
