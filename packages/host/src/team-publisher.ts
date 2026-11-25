import type { TeamMember } from "./team-types.js";
import type { Config } from "./types.js";
import { mirrorRemoteUrl } from "./project-source.js";
import { hostGithubGrantEnvironment } from "./github-grants.js";
import { publishTeamHead } from "./team-workspace.js";
import { filesystemEntryExists, type TeamKernel } from "./team-kernel.js";
import type { Stored, TeamServiceOptions } from "./teams.js";

export type PublisherHost = Pick<TeamKernel, "records" | "config" | "save" | "event" | "enqueue"> & {
  readonly options: TeamServiceOptions | undefined;
  retentionNow(): string;
};

export class TeamPublisher {
  private readonly publishingRuns = new Set<string>();
  readonly publicationTasks = new Set<Promise<void>>();
  readonly publicationControllers = new Map<string, AbortController>();
  constructor(private readonly host: PublisherHost) {}
  publishHeadsEnabled() {
    const teams = this.host.config.teams as (NonNullable<Config["teams"]> & { publishHeads?: boolean }) | undefined;
    return teams?.publishHeads !== false;
  }
  publicationTarget(stored: Stored) {
    if (!this.publishHeadsEnabled() || stored.run.replay) return undefined;
    const { run } = stored, project = this.host.config.projects.find(item => item.id === run.projectId);
    const repository = run.delivery?.repository ?? (project?.source?.mode === "github" ? project.source.repository : undefined);
    if (!repository) return undefined;
    return { repository, remoteUrl: mirrorRemoteUrl({ repository }, this.host.config.source?.remoteOverrides?.[run.projectId]) };
  }
  needsPublication(stored: Stored) {
    const { run } = stored, target = this.publicationTarget(stored);
    return Boolean(target && run.headCommit && run.headCommit !== run.baseCommit && !["merged", "no-change"].includes(run.status) &&
      !(run.publication?.commit === run.headCommit && run.publication.repository === target.repository) &&
      !run.workspaceRemovedAt && filesystemEntryExists(run.workspace));
  }
  publicationGate(stored: Stored, role: TeamMember["role"]) {
    if ((role !== "reviewer" && role !== "delivery") || !this.needsPublication(stored)) return false;
    this.startPublication(stored);
    return true;
  }
  startPublication(stored: Stored) {
    const { run } = stored, target = this.publicationTarget(stored), commit = run.headCommit;
    if (!target || !commit || !this.needsPublication(stored) || this.publishingRuns.has(run.id)) return false;
    const now = this.host.options?.now?.() ?? Date.now();
    const failure = run.publication?.failure;
    if (failure?.commit === commit && now < Date.parse(failure.retryAt)) return false;
    const id = run.id, runBranch = run.branch, controller = new AbortController();
    const checkpoint = run.pullRequest && run.pullRequest.revision !== run.revision ? `${runBranch}-${commit.slice(0, 8)}` : undefined;
    this.publishingRuns.add(id);
    this.publicationControllers.set(id, controller);
    let task: Promise<void>;
    task = (async () => {
      let outcome: Awaited<ReturnType<typeof publishTeamHead>> = { published: false, category: "other" };
      let branch = checkpoint ?? runBranch, diverged = false;
      const grantEnv = (ref: string) => hostGithubGrantEnvironment(this.host.config, { sid: `publish:${id}`, project: run.projectId, repo: target.repository, ops: ["push"], refs: [ref] });
      try {
        outcome = await publishTeamHead(run.workspace, target.remoteUrl, commit, branch, this.host.config.teams?.commandPrefix, controller.signal, grantEnv);
        if (!checkpoint && !outcome.published && outcome.category === "rejected") {
          branch = `${runBranch}-${commit.slice(0, 8)}`;
          outcome = await publishTeamHead(run.workspace, target.remoteUrl, commit, branch, this.host.config.teams?.commandPrefix, controller.signal, grantEnv);
          diverged = outcome.published;
        }
      } catch {
        outcome = { published: false, category: "other" };
      }
      await this.host.enqueue(id, () => {
        if (this.host.records.get(id) !== stored) return;
        const previousPublication = run.publication, previousEvents = run.events.slice();
        const at = this.host.retentionNow();
        if (outcome.published) {
          run.publication = { repository: target.repository, branch, commit, publishedAt: at };
          this.host.event(stored, diverged
            ? `Published head ${commit.slice(0, 12)} to GitHub ${target.repository} ${branch}; GitHub's run branch had diverged, so the head was published as the sibling branch.`
            : checkpoint ? `Published head ${commit.slice(0, 12)} to GitHub ${target.repository} ${branch} as a checkpoint. The pull request is updated only by delivery, after checks and the independent review pass.`
            : `Published head ${commit.slice(0, 12)} to GitHub ${target.repository} ${branch}.`);
        } else {
          const previous = previousPublication?.repository === target.repository ? previousPublication : undefined;
          const attempts = previous?.failure?.commit === commit ? previous.failure.attempts + 1 : 1;
          const retryMs = Math.min(60_000 * 2 ** (attempts - 1), 60 * 60_000);
          run.publication = {
            repository: target.repository,
            branch: previous?.branch ?? runBranch,
            ...(previous?.commit ? { commit: previous.commit } : {}),
            ...(previous?.publishedAt ? { publishedAt: previous.publishedAt } : {}),
            failure: { commit, category: outcome.category, attempts, at, retryAt: new Date(Date.parse(at) + retryMs).toISOString() },
          };
          const event = `Could not publish head ${commit.slice(0, 12)} to GitHub (${outcome.category}); the head is only on the host until a retry succeeds.`;
          if (!run.events.some(item => item.text === event)) this.host.event(stored, event);
          if (attempts === 3) this.host.event(stored, `Head ${commit.slice(0, 12)} failed to publish to GitHub ${target.repository} three times. Review and delivery wait, and the host keeps retrying up to hourly; check the GitHub App's access to that repository.`);
        }
        try { this.host.save(stored); }
        catch (error) { run.publication = previousPublication; run.events = previousEvents; throw error; }
      });
    })().catch(() => {
      console.warn("Could not record the result of a background team head publication.");
    }).finally(() => {
      this.publishingRuns.delete(id);
      this.publicationControllers.delete(id);
      this.publicationTasks.delete(task);
    });
    this.publicationTasks.add(task);
    return true;
  }
}
