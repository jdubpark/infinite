import { randomBytes, randomUUID } from "node:crypto";
import { git, missionHarness, scriptedMissionHarness } from "../mission-harness.js";
import { startIntakeLinearServer, type IntakeFixtureIssue } from "./intake-linear-server.js";
import type { IntakeThread, IntakeThreadReader, SlackThreadMessage } from "../../packages/host/src/intake-types.js";
import { IntakeStore } from "../../packages/host/src/intake-store.js";
import { IntakeLinear } from "../../packages/host/src/intake-linear.js";
import { IntakeService } from "../../packages/host/src/intake.js";
import { testIntakeAudience } from "./slack-server.js";
import { LinearService } from "../../packages/host/src/linear.js";
import { SlackError } from "../../packages/host/src/slack-client.js";
import type { Config } from "../../packages/host/src/types.js";
import type { MissionService } from "../../packages/host/src/missions.js";
import type { RouteReading } from "../../packages/host/src/intake-route.js";

export const OWNER_SLACK = "U00000000", TEAMMATE_SLACK = "U22222222", AGENT_SLACK = "U11111111";
export const MINUTE = 60000;
export const slackTs = (ms: number) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`;
export const slackLink = (ts: string) => `https://example.slack.com/archives/C0000000000/p${ts.replace(".", "")}`;
export const ownerMention = (root: string): SlackThreadMessage[] => [{ ts: root, user: OWNER_SLACK, text: `Please export this <@${AGENT_SLACK}>` }];

class FakeThreads implements IntakeThreadReader {
  readonly threads = new Map<string, SlackThreadMessage[]>();
  readonly unreadable = new Set<string>();
  failNext = 0;
  failure: Error = new Error("Slack is unavailable");
  permalinkFails = false;
  gate?: Promise<void>;
  waiting = 0;
  async organizationChannelAllowed(_channelId: string): Promise<boolean> { return true; }
  async permalink(binding: IntakeThread, ts: string): Promise<string> {
    if (this.permalinkFails) throw new SlackError("internal_error", true);
    return `https://example.slack.com/archives/${binding.channelId}/p${ts.replace(".", "")}`;
  }
  async thread(binding: IntakeThread): Promise<SlackThreadMessage[] | "unreadable"> {
    if (this.gate) { this.waiting += 1; await this.gate; }
    if (this.failNext > 0) { this.failNext -= 1; throw this.failure; }
    if (this.unreadable.has(binding.threadTs)) return "unreadable";
    return this.threads.get(binding.threadTs) ?? [];
  }
}

export async function setup(options: { groupId?: string; maxActive?: number; requireSlackThread?: boolean; mirror?: boolean; scripted?: boolean; admitIssues?: boolean; answerQuestions?: boolean; classify?: boolean; router?: (text: string) => Promise<RouteReading | undefined>; routeWaitMs?: number; reportName?: string;
  wrapMissions?: (missions: MissionService) => MissionService } = {}) {
  const linearServer = await startIntakeLinearServer();
  const threads = new FakeThreads();
  const control: { blocked?: Error } = {};
  let config!: Config;
  const configure = (target: Config) => {
    config = target;
    target.linear = { apiKeyFile: linearServer.apiKeyFile, endpoint: linearServer.endpoint, ...(options.reportName ? { reportName: options.reportName } : {}) };
    target.intake = {
      linear: { teamIds: [linearServer.teamId], creatorId: linearServer.ownerId, label: "infinite", commentsMirrorToSlack: options.mirror ?? false, admitIssues: options.admitIssues ?? true },
      slack: { appTokenFile: "/srv/infinite-data/slack-app-token", botTokenFile: "/srv/infinite-data/slack-bot-token", teamId: "T00000000",
        ownerUserId: OWNER_SLACK, linearAgentUserId: AGENT_SLACK, bindByMention: false, directRequests: true,
        answerQuestions: options.answerQuestions ?? false, classify: options.classify ?? false,
        organizationScope: { workspaces: target.projects.map(project => ({ projectId: project.id, path: project.path, repository: null,
          rootCommit: git(project.path, "rev-list", "--max-parents=0", "HEAD") })) } },
      mission: { groupId: options.groupId ?? "shop", maxSubtasks: 8, maxMinutes: 30 },
      maxActive: options.maxActive ?? 3,
      requireSlackThread: options.requireSlackThread ?? true,
    };
  };
  const built = options.scripted ? scriptedMissionHarness({ configure }) : missionHarness({ configure });
  let missions: MissionService;
  if ("open" in built) { built.open(); missions = built.services().missions; }
  else missions = built.missions;
  if (options.wrapMissions) missions = options.wrapMissions(missions);
  const storeKey = randomBytes(32);
  const store = new IntakeStore(config, storeKey);
  const audience = testIntakeAudience(config);
  const enabled = Date.parse(store.enabledAt());
  const linearService = new LinearService(config, randomBytes(32));
  const logged: { line: string; error: unknown }[] = [];
  const service = (linear = new IntakeLinear(linearService)) => new IntakeService(config, store, missions, linear, { threads, audience, pollMs: 3600000, ...(options.router ? { router: options.router } : {}), ...(options.routeWaitMs ? { routeWaitMs: options.routeWaitMs } : {}),
    log: (line, error) => logged.push({ line, error }),
    create: async (request, origin) => {
      if (control.blocked) throw control.blocked;
      return missions.create(request, undefined, origin);
    } });
  const intake = service();
  const addThread = (offset: number, messages: (root: string) => SlackThreadMessage[]) => {
    const root = slackTs(enabled + offset);
    threads.threads.set(root, messages(root));
    return { root, link: slackLink(root) };
  };
  const issue = (overrides: Partial<IntakeFixtureIssue> = {}, offset = 2000): IntakeFixtureIssue => {
    const thread = addThread(offset, ownerMention);
    return linearServer.file({ createdAt: new Date(enabled + 3000).toISOString(), attachmentUrls: [thread.link], ...overrides });
  };
  return {
    h: built, scripted: built as ReturnType<typeof scriptedMissionHarness>, store, storeKey, missions, threads, control, logged, linear: linearService, linearServer, config, enabled, intake, service, audience, addThread, issue,
    iso: (offset: number) => new Date(enabled + offset).toISOString(),
    list: () => intake.list(),
    close: async () => {
      intake.close();
      linearService.close();
      await linearServer.close();
      await built.close();
    },
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

export function direct(ctx: Context, text = "Export fails on empty rows\nPlease fix the exporter", more: (root: string) => SlackThreadMessage[] = () => [], offset = 2000) {
  const root = slackTs(ctx.enabled + offset);
  const thread: IntakeThread = { channelId: "C0000000000", threadTs: root };
  ctx.threads.threads.set(root, [{ ts: root, user: OWNER_SLACK, text }, ...more(root)]);
  return { thread, ts: root, eventId: `Ev${randomUUID().slice(0, 8)}`, text };
}
