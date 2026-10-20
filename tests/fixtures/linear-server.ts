import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

export interface FixtureIssue {
  id: string; identifier: string; url: string; title: string; description: string;
  updatedAt: string; archivedAt: string | null; team: { id: string }; project: { id: string } | null; parent: { id: string } | null;
  state: { id: string; name: string; type: string };
}
interface FixtureComment { id: string; body: string; issue: { id: string } }
type WriteOperation = "InfiniteLinearIssueCreate" | "InfiniteLinearIssueUpdate" | "InfiniteLinearCommentCreate";
type IssueEdit = Partial<Pick<FixtureIssue, "id" | "title" | "description" | "team" | "project" | "parent" | "state" | "archivedAt">>;

/** A GraphQL peer with committed writes that can lose their HTTP acknowledgement. */
export async function startLinearServer() {
  const apiKey = randomBytes(32).toString("hex"), teamId = randomUUID();
  const issues = new Map<string, FixtureIssue>(), comments = new Map<string, FixtureComment>();
  const labels = new Map<string, { id: string; name: string; team: { id: string } | null }>(), issueLabels = new Map<string, Set<string>>();
  let failLabels = false, rateLimitLabels = false, rateLimitLabelChanges = false;
  const calls: { operation: string; variables: Record<string, any> }[] = [];
  const lostResponses: { operation: WriteOperation; id: string }[] = [];
  const violations: string[] = [];
  let drop: { operation: WriteOperation; bodyIncludes?: string } | undefined, titleUpdateEdit: IssueEdit | undefined, unavailable = false, clock = Date.now();
  let holdTitle = false, rejectTitle = false; const heldTitles: { id: string; title: string }[] = [];
  const updatedAt = () => new Date(++clock).toISOString();
  const linearDescription = (value: string) => value.replace(/(?<![\[(<])https?:\/\/[^\s)>]+/g, url => `[${url}](<${url}>)`)
    .replace(/^([ \t]*)- /gm, "$1* ").trimEnd();
  const seedIssue = (input: { id?: string; title: string; description: string; parentId?: string; projectId?: string }) => {
    const identifier = `TEST-${issues.size + 1}`;
    const issue: FixtureIssue = { id: input.id ?? randomUUID(), identifier,
      url: `https://linear.app/example/issue/${identifier}`, title: input.title, description: input.description,
      updatedAt: updatedAt(), archivedAt: null, team: { id: teamId }, project: input.projectId ? { id: input.projectId } : null, parent: input.parentId ? { id: input.parentId } : null,
      state: { id: randomUUID(), name: "Todo", type: "unstarted" } };
    issues.set(issue.id, issue); return issue;
  };
  const server = createServer(async (request, response) => {
    const reply = (status: number, data: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    };
    if (request.method !== "POST" || request.url !== "/graphql") { reply(404, {}); return; }
    if (request.headers.authorization !== apiKey) { violations.push("Invalid API key header"); reply(401, {}); return; }
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      const operation = parsed.operationName ?? /(?:query|mutation)\s+(\w+)/.exec(parsed.query ?? "")?.[1];
      const variables = parsed.variables ?? {};
      calls.push({ operation, variables });
      if (unavailable) { reply(503, { errors: [{ message: "Fixture transport unavailable" }] }); return; }
      let data: unknown, writtenId: string | undefined;
      switch (operation) {
        case "InfiniteLinearIssue":
          data = { issue: issues.get(variables.id) ?? [...issues.values()].find(issue => issue.identifier === variables.id) ?? null };
          break;
        case "InfiniteLinearIssues": {
          const ids = variables.filter?.id?.in;
          if (!Array.isArray(ids)) throw new Error("Issue reconciliation requires canonical IDs");
          data = { issues: { nodes: ids.flatMap(id => issues.has(id) ? [issues.get(id)] : []),
            pageInfo: { hasNextPage: false, endCursor: null } } };
          break;
        }
        case "InfiniteLinearIssueCreate": {
          const input = variables.input;
          if (!input?.id || !input.title || typeof input.description !== "string" || input.teamId !== teamId)
            throw new Error("Incomplete issue creation");
          if (input.stateId !== undefined) throw new Error("The bridge must leave issue state to humans");
          if (issues.has(input.id)) { reply(200, { errors: [{ message: "Issue ID already exists" }] }); return; }
          const issue = seedIssue({ ...input, description: linearDescription(input.description) });
          writtenId = issue.id; data = { issueCreate: { success: true, issue } }; break;
        }
        case "InfiniteLinearIssueUpdate": {
          const issue = issues.get(variables.id), input = variables.input;
          if (!issue || typeof input?.title !== "string") throw new Error("Incomplete issue update");
          // A held update fails before it commits; the test commits it later to model a delayed write.
          if (holdTitle) { holdTitle = false; heldTitles.push({ id: issue.id, title: input.title }); response.destroy(); return; }
          if (rejectTitle) { rejectTitle = false; data = { issueUpdate: { success: false, issue: null } }; break; }
          Object.assign(issue, { title: input.title, ...titleUpdateEdit, updatedAt: updatedAt() });
          titleUpdateEdit = undefined;
          writtenId = issue.id; data = { issueUpdate: { success: true, issue } }; break;
        }
        case "InfiniteLinearComment": {
          const id = variables.filter?.id?.eq;
          if (typeof id !== "string") throw new Error("Comment reconciliation requires its persisted ID");
          data = { comments: { nodes: comments.has(id) ? [comments.get(id)] : [] } }; break;
        }
        case "InfiniteLinearCommentCreate": {
          const input = variables.input;
          if (!input?.id || typeof input.body !== "string" || !issues.has(input.issueId)) throw new Error("Incomplete comment creation");
          if (comments.has(input.id)) { reply(200, { errors: [{ message: "Comment ID already exists" }] }); return; }
          const comment = { id: input.id, body: input.body, issue: { id: input.issueId } };
          comments.set(comment.id, comment); writtenId = comment.id;
          data = { commentCreate: { success: true, comment } }; break;
        }
        case "InfiniteLinearLabels": {
          const name = variables.filter?.name?.eqIgnoreCase;
          if (typeof name !== "string") throw new Error("Label lookup requires a name");
          if (failLabels) { reply(200, { errors: [{ message: "Fixture label failure" }] }); return; }
          if (rateLimitLabels) { response.writeHead(200, { "Content-Type": "application/json", "retry-after": "120" }).end(JSON.stringify({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] })); return; }
          data = { issueLabels: { nodes: [...labels.values()].filter(label => label.name.toLowerCase() === name.toLowerCase()) } }; break;
        }
        case "InfiniteLinearLabelCreate": {
          const input = variables.input;
          if (!input?.name || input.teamId !== teamId) throw new Error("Label creation must name the run's team");
          const label = { id: randomUUID(), name: input.name, team: { id: teamId } };
          labels.set(label.id, label); data = { issueLabelCreate: { success: true, issueLabel: label } }; break;
        }
        case "InfiniteLinearIssueAddLabel":
        case "InfiniteLinearIssueRemoveLabel": {
          if (!issues.has(variables.id)) throw new Error("Label change needs a known issue");
          if (rateLimitLabelChanges) { response.writeHead(200, { "Content-Type": "application/json", "retry-after": "120" }).end(JSON.stringify({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] })); return; }
          // Linear answers an unknown (for example deleted) label with an error, not a protocol violation.
          if (!labels.has(variables.labelId)) { reply(200, { errors: [{ message: "Entity not found: IssueLabel" }] }); return; }
          const applied = issueLabels.get(variables.id) ?? new Set<string>(), adding = operation === "InfiniteLinearIssueAddLabel";
          if (adding) applied.add(variables.labelId); else applied.delete(variables.labelId);
          issueLabels.set(variables.id, applied);
          data = { [adding ? "issueAddLabel" : "issueRemoveLabel"]: { success: true } }; break;
        }
        default: throw new Error(`Unexpected GraphQL operation: ${operation}`);
      }
      if (drop && operation === drop.operation && writtenId && (!drop.bodyIncludes || variables.input?.body?.includes(drop.bodyIncludes))) {
        lostResponses.push({ operation, id: writtenId });
        drop = undefined; unavailable = true;
        response.destroy(); return;
      }
      reply(200, { data });
    } catch (error) {
      violations.push(error instanceof Error ? error.message : "Invalid fixture request");
      reply(200, { errors: [{ message: violations.at(-1) }] });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Linear fixture needs a TCP address");
  return { endpoint: `http://127.0.0.1:${address.port}/graphql`, apiKey, teamId, issues, comments, calls, lostResponses, violations, seedIssue, labels, issueLabels,
    failLabelLookups(value: boolean) { failLabels = value; },
    rateLimitLabelLookups(value: boolean) { rateLimitLabels = value; },
    rateLimitLabelChanges(value: boolean) { rateLimitLabelChanges = value; },
    dropNextResponse(operation: WriteOperation, bodyIncludes?: string) { drop = { operation, bodyIncludes }; },
    restore() { unavailable = false; },
    editIssue(id: string, changes: IssueEdit) {
      const issue = issues.get(id); if (!issue) throw new Error("Unknown fixture issue");
      Object.assign(issue, changes, { updatedAt: updatedAt() });
    },
    editOnNextTitleUpdate(changes: IssueEdit) { titleUpdateEdit = changes; },
    holdNextTitleUpdate() { holdTitle = true; },
    rejectNextTitleUpdate() { rejectTitle = true; },
    commitHeldTitleUpdate() {
      const held = heldTitles.shift(); if (!held) throw new Error("No held title update");
      Object.assign(issues.get(held.id)!, { title: held.title, updatedAt: updatedAt() });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
