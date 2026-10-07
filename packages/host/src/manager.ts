import { spawn } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  applyLifecycle,
  initialAttention,
  type Attention,
} from "@infinite/attention";
import { readEvents, unseal, writeSealed } from "./vault.js";
import { workerCall } from "./ipc.js";
import { assertRunnerDeployment } from "./deployment.js";
import { DEFAULT_HOOKS } from "./config.js";
import { validateNativeCodexArgs } from "./native-codex.js";
import type {
  Config,
  Provider,
  Session,
  WorkerState,
  Bootstrap,
} from "./types.js";

export interface CreateSession {
  requestId: string;
  provider: Provider;
  projectId: string;
  title: string;
  prompt: string;
  nativeArgs?: string[];
  localUi?: boolean;
}
interface StoredSession {
  session: Session;
  fingerprint: string;
}
/** List rows stay small: the last message is cut and tool input stays on the detail endpoint. */
export function publicAttention(att: Attention): Attention {
  const lastMessage = att.lastMessage?.slice(0, 280);
  if (!att.prompt) return { ...att, lastMessage };
  const { tool, ...prompt } = att.prompt;
  return {
    ...att,
    prompt: {
      ...prompt,
      ...(tool ? { tool: { name: tool.name, input: {} } } : {}),
    },
    lastMessage,
  };
}
/**
 * Older workers deliberately survive API upgrades and answer `state` without attention. Such a
 * row gets an attention block so list rows, the Notifier and the phone never meet a missing
 * field, but the block never invents an idle or finished state: a live old worker reads as
 * `unavailable` (the host cannot tell what it is doing) and a stopped one keeps its lifecycle.
 */
export function withDefaultAttention(
  state: Omit<WorkerState, "attention"> & { attention?: Attention },
  now = new Date().toISOString(),
): WorkerState {
  if (state.attention) return state as WorkerState;
  const status =
    state.status === "exited" || state.status === "recording-error"
      ? state.status
      : "unavailable";
  return {
    ...state,
    attention: applyLifecycle(initialAttention(now, false), status, now),
  };
}
const unavailable = (now = new Date().toISOString()): WorkerState => ({
  status: "unavailable",
  seq: 0,
  screen: "",
  attention: applyLifecycle(initialAttention(now, false), "unavailable", now),
});
export class Manager {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    readonly config: Config,
    readonly key: Buffer,
  ) {
    assertRunnerDeployment(config);
    mkdirSync(join(config.stateDir, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(config.runDir, { recursive: true, mode: 0o700 });
    if (
      Buffer.byteLength(
        join(config.runDir, "00000000-0000-0000-0000-000000000000.sock"),
      ) > 100
    )
      throw new Error(
        "runDir is too long for a Unix socket; choose a shorter path",
      );
  }
  meta(id: string): StoredSession {
    return unseal(
      this.key,
      `${id}:meta`,
      readFileSync(
        join(this.config.stateDir, "sessions", id, "meta.sealed"),
        "utf8",
      ),
    );
  }
  async state(id: string, screen = false): Promise<WorkerState> {
    try {
      return withDefaultAttention(
        await workerCall(this.config.runDir, id, { op: "state", screen }),
      );
    } catch {
      const file = join(this.config.stateDir, "sessions", id, "status.sealed");
      if (existsSync(file)) {
        const saved = unseal<WorkerState>(
          this.key,
          `${id}:status`,
          readFileSync(file, "utf8"),
        );
        const status = saved.status === "exited" ? "exited" : "unavailable";
        const now = new Date().toISOString();
        return {
          ...saved,
          status,
          screen: "",
          attention: applyLifecycle(
            saved.attention ?? initialAttention(now, false),
            status,
            now,
          ),
        };
      }
      return unavailable();
    }
  }
  /**
   * Every session whose metadata can be read. One session's unreadable status (or a worker
   * that fails to answer) shows that row as unavailable instead of failing the whole list;
   * a session without readable metadata has no title or provider to show and is left out.
   */
  async list() {
    const ids = readdirSync(join(this.config.stateDir, "sessions")).filter(
      (n) => /^[a-f0-9-]{36}$/.test(n),
    );
    const rows = await Promise.allSettled(
      ids.map(async (id) => {
        const { session } = this.meta(id);
        const { screen: _screen, ...state } = await this.state(id).catch(
          () => unavailable(),
        );
        const {
          context: _context,
          initialPrompt: _prompt,
          nativeArgs: _nativeArgs,
          cwd: _cwd,
          ...summary
        } = session;
        return {
          ...summary,
          ...state,
          attention: publicAttention(state.attention),
        };
      }),
    );
    return rows.flatMap((row) =>
      row.status === "fulfilled" ? [row.value] : [],
    );
  }
  context(projectId: string): {
    version: number;
    text: string;
    updatedAt?: string;
  } {
    const file = join(this.config.stateDir, "contexts", `${projectId}.sealed`);
    return existsSync(file)
      ? unseal(this.key, `context:${projectId}`, readFileSync(file, "utf8"))
      : { version: 0, text: "" };
  }
  setContext(projectId: string, text: string, expectedVersion: number) {
    const current = this.context(projectId);
    if (current.version !== expectedVersion)
      throw new Error(
        "Context changed on another device. Reload before saving.",
      );
    const next = {
      version: current.version + 1,
      text,
      updatedAt: new Date().toISOString(),
    };
    writeSealed(
      join(this.config.stateDir, "contexts", `${projectId}.sealed`),
      this.key,
      `context:${projectId}`,
      next,
    );
    return next;
  }
  create(request: CreateSession): Promise<Session & WorkerState> {
    const operation = this.serial.then(() => this.createOnce(request));
    this.serial = operation.catch(() => {});
    return operation;
  }
  private async createOnce(request: CreateSession) {
    if (request.localUi) {
      if (request.provider !== "codex") throw new Error("Local native UI is currently available for Codex only");
      validateNativeCodexArgs(request.nativeArgs ?? [], request.nativeArgs === undefined ? request.prompt : "");
    }
    const id = request.requestId;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const dir = join(this.config.stateDir, "sessions", id);
    if (existsSync(join(dir, "meta.sealed"))) {
      const stored = this.meta(id);
      if (stored.fingerprint !== fingerprint)
        throw new Error("Request ID already belongs to a different session");
      return { ...stored.session, ...(await this.state(id)) };
    }
    const project = this.config.projects.find(
      (p) => p.id === request.projectId,
    );
    if (!project) throw new Error("Unknown project");
    if (request.provider === "demo" && !this.config.enableDemo)
      throw new Error("Demo is disabled");
    if (
      (await this.list()).filter(
        (s) => s.status === "running" || s.status === "starting",
      ).length >= this.config.maxSessions
    )
      throw new Error("The configured session limit has been reached");
    const profile = this.config.agents[request.provider];
    if (!profile) throw new Error("Provider is not configured on this host");
    const context = this.context(request.projectId);
    const session: Session = {
      id,
      provider: request.provider,
      title: request.title,
      projectId: request.projectId,
      cwd: realpathSync(project.path),
      createdAt: new Date().toISOString(),
      status: "starting",
      contextVersion: context.version,
      context: context.text,
      initialPrompt: request.prompt,
      runtime: { id: randomUUID(), location: this.config.environment, transport: "pty", ...(request.localUi ? { nativeUi: "codex" as const } : {}) },
      ...(request.nativeArgs !== undefined ? { nativeArgs: request.nativeArgs } : {}),
    };
    // Native CLI arguments are exact: do not append a second positional prompt or
    // provider settings. The context snapshot remains available in the record.
    const prompt = request.nativeArgs !== undefined ? "" : [
      context.text
        ? `Shared project context (version ${context.version}, provided by the owner):\n${context.text}`
        : "",
      request.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeSealed(join(dir, "meta.sealed"), this.key, `${id}:meta`, {
      session,
      fingerprint,
    });
    const worker = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
        import.meta.url,
      ),
    );
    const args = worker.endsWith(".ts")
      ? ["--import", "tsx", worker]
      : [worker];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        session,
        profile: request.nativeArgs === undefined || request.localUi ? profile : {
          ...profile, args: [...profile.args, ...request.nativeArgs],
        },
        stateDir: this.config.stateDir,
        runDir: this.config.runDir,
        key: this.key.toString("base64"),
        prompt,
        attention: {
          // Native CLI launches keep their exact argv: no hook settings are injected.
          hooks: request.nativeArgs !== undefined
            ? { claude: false, codex: false }
            : this.config.attention?.hooks ?? DEFAULT_HOOKS,
          idleAfterMs: this.config.attention?.idleAfterMs ?? 20000,
        },
      } satisfies Bootstrap),
    );
    child.unref();
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await this.state(id);
      if (state.status !== "unavailable" && state.status !== "starting")
        return { ...session, ...state };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ...session, ...(await this.state(id)) };
  }
  events(id: string, after: number, limit: number, types?: Set<string>) {
    this.meta(id);
    return readEvents(
      join(this.config.stateDir, "sessions", id, "events"),
      this.key,
      id,
      after,
      limit,
      types,
    );
  }
}
