import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { IntakeSlackSurface, type DirectRequest } from "../../packages/host/src/intake-slack.js";
import { IntakeStore } from "../../packages/host/src/intake-store.js";
import { SlackClient } from "../../packages/host/src/slack-client.js";
import type { IntakeThread } from "../../packages/host/src/intake-types.js";
import type { Config } from "../../packages/host/src/types.js";
import type { MissionService } from "../../packages/host/src/missions.js";
import type { TeamService } from "../../packages/host/src/teams.js";
import { waitFor } from "../helpers.js";
import { slackAudienceFixture, slackClientForFixture as slackClient, startSlackServer, testIntakeAudience } from "./slack-server.js";

export const OWNER = "U00000000", BOT = "U00000001";
export const BINDING: IntakeThread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
export const OTHER: IntakeThread = { channelId: "C0000000001", threadTs: "1700000000.000200" };
export const THIRD: IntakeThread = { channelId: "C0000000002", threadTs: "1700000000.000300" };
export const PROJECT_PATH = "/data/instances/work/api";
export const { scope: TEST_SCOPE, identity: TEST_AUDIENCE_ID, projects: TEST_PROJECTS } = slackAudienceFixture();

export type Services = { missions: MissionService; teams: TeamService };
export type SurfaceOptions = {
  bindByMention?: boolean; serverTeamId?: string; wrapClient?: (client: SlackClient) => SlackClient;
  log?: (line: string, error: unknown) => void; directRequests?: boolean; direct?: DirectRequestFactory;
};
type DirectRequestFactory = (store: IntakeStore) => DirectRequest;

export function wrapSlackClient(client: SlackClient, overrides: Partial<SlackClient>): SlackClient {
  return new Proxy(client, { get(target, property) {
    const override = Reflect.get(overrides, property);
    if (override !== undefined) return override;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export async function surfaceFor(services: Services, stateRoot: string, options: SurfaceOptions = {}) {
  const slack = await startSlackServer({ teamId: options.serverTeamId });
  for (const thread of [BINDING, OTHER]) slack.seedThread(thread, [{ user: OWNER, text: "Export fails on empty rows" }]);
  const realClient = slackClient(slack), client = options.wrapClient ? options.wrapClient(realClient) : realClient;
  const config = { stateDir: join(stateRoot, "intake"), runDir: join(stateRoot, "run"), projects: TEST_PROJECTS, intake: {
    linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "infinite", commentsMirrorToSlack: false },
    slack: { appTokenFile: slack.appTokenFile, botTokenFile: slack.botTokenFile, teamId: "T00000000", ownerUserId: OWNER,
      bindByMention: options.bindByMention ?? false, endpoint: slack.endpoint, organizationScope: TEST_SCOPE,
      ...(options.directRequests !== undefined ? { directRequests: options.directRequests } : {}) },
    mission: { groupId: "shop", maxSubtasks: 8, maxMinutes: 30 }, maxActive: 3, requireSlackThread: true,
  } } as unknown as Config;
  const store = new IntakeStore({ stateDir: join(stateRoot, "intake") } as Config, randomBytes(32));
  const surface = new IntakeSlackSurface(config, store, services.missions, services.teams, client,
    { log: options.log ?? (() => undefined), audience: testIntakeAudience(config), ...(options.direct ? { direct: options.direct(store) } : {}) });
  return { slack, store, surface, client, realClient, config,
    texts: (binding: IntakeThread = BINDING) => slack.posts(binding).map(post => post.text),
    connected: () => waitFor(async () => surface.status().connected, Boolean, 10000),
    close: async () => { surface.close(); await slack.close(); },
  };
}
