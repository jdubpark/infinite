import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/** The fields intake reads from Linear. Defaults make an unlabelled-free, open, owner-created issue in the fixture team. */
export interface IntakeFixtureIssue {
  id: string; identifier: string; url: string; title: string; description: string;
  createdAt: string; updatedAt: string; archivedAt: string | null;
  teamId: string; stateType: string; labels: string[]; creatorId: string | null;
  /** Attachment URLs; a Slack thread link here is how an issue names its thread. */
  attachmentUrls: string[];
}
export interface IntakeFixtureComment { id: string; body: string; issueId: string }

/**
 * A loopback GraphQL peer for intake. It filters by team only, so the service's own re-checks (label, creator,
 * archived, state, creation time) are what the tests exercise. Its writes commit before a lost response is returned.
 */
export async function startIntakeLinearServer(options: { clock?: () => number } = {}) {
  const apiKey = randomBytes(32).toString("hex"), teamId = randomUUID(), ownerId = randomUUID();
  const directory = mkdtempSync(join(tmpdir(), "intake-linear-"));
  const apiKeyFile = join(directory, "linear-key");
  writeFileSync(apiKeyFile, apiKey, { mode: 0o600 });
  const issues = new Map<string, IntakeFixtureIssue>(), comments = new Map<string, IntakeFixtureComment>();
  const calls: { operation: string; variables: Record<string, any> }[] = [];
  let loseNext = false, unavailableValue = false, count = 0;
  const malformed = new Set<string>(), malformedCreator = new Set<string>();
  const now = options.clock ?? (() => Date.now());
  const stamp = () => new Date(now()).toISOString();

  const node = (issue: IntakeFixtureIssue) => malformed.has(issue.id) ? { id: issue.id, unexpected: true } : ({
    id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title, description: issue.description,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt, archivedAt: issue.archivedAt,
    team: { id: issue.teamId }, state: { type: issue.stateType },
    labels: { nodes: issue.labels.map(name => ({ name })) },
    creator: malformedCreator.has(issue.id) ? { id: "not-a-uuid" } : issue.creatorId ? { id: issue.creatorId } : null,
    attachments: { nodes: issue.attachmentUrls.map(url => ({ url })) },
  });
  const server = createServer(async (request, response) => {
    const reply = (status: number, data: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (request.method !== "POST" || request.url !== "/graphql") { reply(404, {}); return; }
    if (request.headers.authorization !== apiKey) { reply(401, {}); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const operation: string = parsed.operationName;
    const variables = parsed.variables ?? {};
    calls.push({ operation, variables });
    if (unavailableValue) { reply(503, { errors: [{ message: "Fixture transport unavailable" }] }); return; }
    switch (operation) {
      case "InfiniteIntakeCandidates": {
        const teams: string[] = variables.filter?.team?.id?.in ?? [];
        const nodes = [...issues.values()].filter(issue => teams.includes(issue.teamId)).map(node);
        reply(200, { data: { issues: { nodes } } });
        return;
      }
      case "InfiniteIntakeIssueStates": {
        const ids: string[] = variables.filter?.id?.in ?? [];
        const nodes = ids.flatMap(id => issues.has(id) ? [node(issues.get(id)!)] : []);
        reply(200, { data: { issues: { nodes } } });
        return;
      }
      case "InfiniteIntakeCommentCreate": {
        const input = variables.input;
        if (!input?.id || !input.issueId || typeof input.body !== "string") throw new Error("Incomplete comment creation");
        if (comments.has(input.id)) { reply(200, { errors: [{ message: "Comment ID already exists" }] }); return; }
        comments.set(input.id, { id: input.id, body: input.body, issueId: input.issueId });
        if (loseNext) {
          loseNext = false;
          response.destroy();
          return;
        }
        reply(200, { data: { commentCreate: { success: true, comment: { id: input.id, body: input.body, issue: { id: input.issueId } } } } });
        return;
      }
      case "InfiniteIntakeComment": {
        const found = comments.get(variables.filter?.id?.eq);
        reply(200, { data: { comments: { nodes: found ? [{ id: found.id, body: found.body, issue: { id: found.issueId } }] : [] } } });
        return;
      }
      default:
        reply(400, { errors: [{ message: `Unknown operation ${operation}` }] });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/graphql`;

  return {
    endpoint, apiKeyFile, teamId, ownerId, calls,
    /** Adds an issue to the fixture team; unset fields take the defaults shown in the fixture. */
    file(input: Partial<IntakeFixtureIssue> & { id?: string } = {}): IntakeFixtureIssue {
      count += 1;
      const at = stamp();
      const issue: IntakeFixtureIssue = {
        title: "Export fails on empty rows", description: "", createdAt: at, updatedAt: at, archivedAt: null,
        teamId, stateType: "unstarted", labels: ["infinite"], creatorId: ownerId, attachmentUrls: [],
        ...input,
        id: input.id ?? randomUUID(), identifier: `TEST-${count}`, url: `https://linear.example.invalid/issue/TEST-${count}`,
      };
      issues.set(issue.id, issue);
      return issue;
    },
    /** Changes an issue as a person would in Linear; the update time moves forward. */
    edit(id: string, change: Partial<IntakeFixtureIssue>) {
      const issue = issues.get(id);
      if (!issue) throw new Error("Fixture has no such issue");
      Object.assign(issue, change, { updatedAt: stamp() });
    },
    /** Returns the issue's node in a shape that intake cannot read; the issue still exists. */
    corrupt(id: string) { malformed.add(id); },
    /** Gives the issue a creator field that is not a Linear user ID. */
    malformCreator(id: string) { malformedCreator.add(id); },
    /** Deletes an issue; later state reads omit it. */
    remove(id: string) { issues.delete(id); },
    /** Comments on an issue, oldest first. */
    comments(issueId: string): IntakeFixtureComment[] {
      return [...comments.values()].filter(comment => comment.issueId === issueId);
    },
    /** The next comment create commits, but its HTTP response is lost. */
    loseNextCommentResponse() { loseNext = true; },
    /** While true, every request fails with a 503. */
    unavailable(value: boolean) { unavailableValue = value; },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
