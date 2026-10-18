import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

export interface FixtureIssue {
  id: string; identifier: string; url: string; title: string; description: string;
  updatedAt: string; archivedAt: string | null; team: { id: string }; parent: { id: string } | null;
  state: { id: string; name: string; type: string };
}
interface FixtureComment { id: string; body: string; issue: { id: string } }
type WriteOperation = "InfiniteLinearIssueCreate" | "InfiniteLinearCommentCreate";

/** A GraphQL peer with committed writes that can lose their HTTP acknowledgement. */
export async function startLinearServer() {
  const apiKey = randomBytes(32).toString("hex"), teamId = randomUUID();
  const issues = new Map<string, FixtureIssue>(), comments = new Map<string, FixtureComment>();
  const calls: { operation: string; variables: Record<string, any> }[] = [];
  const lostResponses: { operation: WriteOperation; id: string }[] = [];
  const violations: string[] = [];
  let drop: { operation: WriteOperation; bodyIncludes?: string } | undefined, unavailable = false, clock = Date.now();
  const updatedAt = () => new Date(++clock).toISOString();
  const seedIssue = (input: { id?: string; title: string; description: string; parentId?: string }) => {
    const identifier = `TEST-${issues.size + 1}`;
    const issue: FixtureIssue = { id: input.id ?? randomUUID(), identifier,
      url: `https://linear.app/example/issue/${identifier}`, title: input.title, description: input.description,
      updatedAt: updatedAt(), archivedAt: null, team: { id: teamId }, parent: input.parentId ? { id: input.parentId } : null,
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
          const issue = seedIssue(input);
          writtenId = issue.id; data = { issueCreate: { success: true, issue } }; break;
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
  return { endpoint: `http://127.0.0.1:${address.port}/graphql`, apiKey, teamId, issues, comments, calls, lostResponses, violations, seedIssue,
    dropNextResponse(operation: WriteOperation, bodyIncludes?: string) { drop = { operation, bodyIncludes }; },
    restore() { unavailable = false; },
    editIssue(id: string, changes: Partial<Pick<FixtureIssue, "title" | "description" | "state" | "archivedAt">>) {
      const issue = issues.get(id); if (!issue) throw new Error("Unknown fixture issue");
      Object.assign(issue, changes, { updatedAt: updatedAt() });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
