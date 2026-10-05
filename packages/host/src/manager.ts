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
import { createHash } from "node:crypto";
import {
  applyLifecycle,
  initialAttention,
  type Attention,
} from "@infinite/attention";
import { readEvents, unseal, writeSealed } from "./vault.js";
import { workerCall } from "./ipc.js";
import { assertRunnerDeployment } from "./deployment.js";
import { DEFAULT_HOOKS } from "./config.js";
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
 * A worker started before attention existed answers `state` without it. Such a row gets the
 * default a fresh session would have, so list rows and the Notifier never meet a missing field.
 */
export function withDefaultAttention(
  state: Omit<WorkerState, "attention"> & { attention?: Attention },
  now = new Date().toISOString(),
): WorkerState {
  if (state.attention) return state as WorkerState;
  const base = initialAttention(now, false);
  const attention =
    state.status === "exited" ||
    state.status === "unavailable" ||
    state.status === "recording-error"
      ? applyLifecycle(base, state.status, now)
      : base;
  return { ...state, attention };
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
    };
    const prompt = [
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
        profile,
        stateDir: this.config.stateDir,
        runDir: this.config.runDir,
        key: this.key.toString("base64"),
        prompt,
        attention: {
          hooks: this.config.attention?.hooks ?? DEFAULT_HOOKS,
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
