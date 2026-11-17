import test from "node:test";
import assert from "node:assert/strict";
import { IntakeLinear, issueFacts } from "../packages/host/src/intake-linear.js";

const queryBudget = 5000;
const teamId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const labelId = "33333333-3333-4333-8333-333333333333";
const commentId = "44444444-4444-4444-8444-444444444444";
const connectionFields = new Set(["issues", "issueLabels", "comments", "labels", "attachments"]);
const objectFields = new Set(["nodes", "pageInfo", "team", "state", "creator", "issue", "issueCreate", "comment", "commentCreate"]);

type CapturedRequest = { operation: string; query: string; variables: Record<string, unknown> };

/** Estimates the documented Linear cost: objects are 1, scalars 0.1, and connections multiply children by `first`. */
function estimateCost(query: string, variables: Record<string, unknown>): number {
  const tokens = query.match(/\$?[A-Za-z_][A-Za-z0-9_]*|\d+|[!$():{},.[\]]/g) ?? [];
  let index = tokens.indexOf("{");
  assert.notEqual(index, -1, "query must have a selection set");

  const argumentsFor = (): Map<string, string> => {
    const args = new Map<string, string>();
    if (tokens[index] !== "(") return args;
    index += 1;
    while (tokens[index] !== ")") {
      if (tokens[index] === ",") { index += 1; continue; }
      const name = tokens[index++];
      assert.equal(tokens[index++], ":", `expected ':' after argument ${name}`);
      args.set(name, tokens[index++]);
    }
    index += 1;
    return args;
  };

  const selectedCost = (): number => {
    assert.equal(tokens[index++], "{");
    let cost = 0;
    while (tokens[index] !== "}") {
      assert.ok(tokens[index], "selection set must close");
      const field = tokens[index++];
      const args = argumentsFor();
      if (tokens[index] === "{") {
        const children = selectedCost();
        if (connectionFields.has(field) || args.has("first")) {
          const firstToken = args.get("first");
          const first = firstToken === undefined ? 50
            : firstToken.startsWith("$") ? variables[firstToken.slice(1)]
              : Number(firstToken);
          assert.equal(typeof first, "number", `${field}.first must resolve to a number`);
          cost += 1 + first * children;
        } else {
          assert.ok(objectFields.has(field), `classify nested Linear field ${field} as an object or connection`);
          cost += 1 + children;
        }
      } else {
        cost += 0.1;
      }
    }
    index += 1;
    return cost;
  };

  return Math.round((1 + selectedCost()) * 10) / 10;
}

const issueNode = (id: string) => ({
  id, identifier: "TEST-1", url: "https://linear.app/team/issue/TEST-1", title: "Intake cost fixture", description: "",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", archivedAt: null,
  team: { id: teamId }, state: { type: "started" }, labels: { nodes: [] }, creator: null, attachments: { nodes: [] },
});

test("all intake Linear operations stay within the 5,000-point query budget", async () => {
  const requests: CapturedRequest[] = [];
  let candidateRequests = 0;
  const linear = {
    async request(operation: string, query: string, variables: unknown): Promise<Record<string, unknown>> {
      const vars = variables as Record<string, unknown>;
      requests.push({ operation, query, variables: vars });
      switch (operation) {
        case "InfiniteIntakeCandidates":
          candidateRequests += 1;
          return { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `cursor-${candidateRequests}` } } };
        case "InfiniteIntakeIssueStates":
          return { issues: { nodes: [] } };
        case "InfiniteIntakeLabel":
          return { issueLabels: { nodes: [{ id: labelId, team: { id: teamId } }] } };
        case "InfiniteIntakeIssueCreate":
          return { issueCreate: { success: true, issue: issueNode(issueId) } };
        case "InfiniteIntakeCommentCreate":
          return { commentCreate: { success: false, comment: { id: commentId, body: "comment", issue: { id: issueId } } } };
        case "InfiniteIntakeComment":
          return { comments: { nodes: [{ id: commentId, body: "comment", issue: { id: issueId } }] } };
        default:
          throw new Error(`Unexpected intake operation: ${operation}`);
      }
    },
  };
  const intake = new IntakeLinear(linear);

  const candidates = await intake.candidates({ teamIds: [teamId], label: "intake", createdAfter: "2026-01-01T00:00:00Z" });
  assert.equal(candidates.capped, true);
  await intake.states(Array.from({ length: 100 }, (_, index) => `state-${index}`));
  await intake.createIssue({ id: issueId, teamId, title: "Intake cost fixture", description: "", label: "intake" });
  await intake.comment(issueId, { id: commentId, body: "comment" });

  const costs = new Map<string, number>();
  for (const request of requests) {
    const cost = estimateCost(request.query, request.variables);
    costs.set(request.operation, Math.max(costs.get(request.operation) ?? 0, cost));
  }
  const overBudget = [...costs].filter(([, cost]) => cost > queryBudget);
  assert.equal(overBudget.length, 0, `intake operations exceed ${queryBudget}: ${overBudget.map(([operation, cost]) => `${operation}=${cost}`).join(", ")}`);
  assert.deepEqual([...costs.keys()].sort(), [
    "InfiniteIntakeCandidates", "InfiniteIntakeComment", "InfiniteIntakeCommentCreate", "InfiniteIntakeIssueCreate",
    "InfiniteIntakeIssueStates", "InfiniteIntakeLabel",
  ].sort());
  assert.equal(candidateRequests, 50);
  assert.ok(requests.filter(request => request.operation === "InfiniteIntakeCandidates").every(request => request.variables.first === 40));
  assert.equal(candidateRequests * 40, 2000, "candidate paging preserves the previous total scan cap");
  console.log(`Intake Linear worst-case costs: ${[...costs].map(([operation, cost]) => `${operation}=${cost}`).join(", ")}`);
});

test("a Slack thread link at the end of the bounded attachment page remains available", () => {
  const attachments = Array.from({ length: 50 }, (_, index) => ({ url: `https://example.invalid/${index}` }));
  attachments[49] = { url: "https://example.slack.com/archives/C0000000000/p1700000000000100" };
  const facts = issueFacts({ ...issueNode(issueId), attachments: { nodes: attachments } });
  assert.deepEqual(facts.thread, { channelId: "C0000000000", threadTs: "1700000000.000100" });
});
