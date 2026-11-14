import { z } from "zod";
import type { LinearService } from "./linear.js";
import type { IntakeThread } from "./intake-types.js";

export interface IntakeIssue {
  id: string; identifier: string; url: string; title: string; description: string;
  createdAt: string; updatedAt: string; archivedAt: string | null;
  teamId: string; stateType: string; labels: string[]; creatorId?: string; thread?: IntakeThread;
}

const issueFields = "id identifier url title description createdAt updatedAt archivedAt team { id } state { type } labels { nodes { name } } creator { id } attachments { nodes { url } }";
const issueNode = z.object({
  id: z.uuid(), identifier: z.string().min(1).max(100), url: z.url().max(2048), title: z.string().min(1).max(512),
  description: z.string().max(64000).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), archivedAt: z.iso.datetime().nullable(),
  team: z.object({ id: z.uuid() }), state: z.object({ type: z.string().min(1).max(40) }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string().max(200) })).max(250) }),
});
const comment = z.object({ id: z.uuid(), body: z.string().max(64000), issue: z.object({ id: z.uuid() }) });
const candidatePage = 200, candidatePages = 10;

/**
 * Reads a Slack message link: a root link (`p` plus sixteen digits) or a reply link whose `thread_ts` names the root.
 * Only https links on slack.com or one of its subdomains count.
 */
export function parseSlackThreadLink(url: string): IntakeThread | undefined {
  let link: URL;
  try { link = new URL(url); } catch { return undefined; }
  const host = link.hostname;
  if (link.protocol !== "https:" || !(host === "slack.com" || host.endsWith(".slack.com"))) return undefined;
  const match = /^\/archives\/([CDG][A-Z0-9]{2,20})\/p(\d{16})$/.exec(link.pathname);
  if (!match) return undefined;
  const replyTs = link.searchParams.get("thread_ts");
  if (replyTs !== null) return /^\d{10}\.\d{6}$/.test(replyTs) ? { channelId: match[1], threadTs: replyTs } : undefined;
  return { channelId: match[1], threadTs: `${match[2].slice(0, 10)}.${match[2].slice(10)}` };
}

/** The only place that knows Linear's field names for an issue's creator and its Slack thread link. */
export function issueFacts(node: unknown): IntakeIssue {
  const parsed = issueNode.parse(node);
  // The creator and thread fields are declared here only, beside the query text in issueFields that asks for them.
  const { creator, attachments } = z.object({
    creator: z.object({ id: z.uuid() }).nullable().optional(),
    attachments: z.object({ nodes: z.array(z.object({ url: z.string().max(4096) })).max(250) }),
  }).parse(node);
  const thread = attachments.nodes.map(attachment => parseSlackThreadLink(attachment.url)).find((value): value is IntakeThread => value !== undefined);
  return {
    id: parsed.id, identifier: parsed.identifier, url: parsed.url, title: parsed.title, description: parsed.description ?? "",
    createdAt: parsed.createdAt, updatedAt: parsed.updatedAt, archivedAt: parsed.archivedAt,
    teamId: parsed.team.id, stateType: parsed.state.type, labels: parsed.labels.nodes.map(label => label.name),
    ...(creator ? { creatorId: creator.id } : {}),
    ...(thread ? { thread } : {}),
  };
}

/** One malformed issue must not hold back the rest of the queue; it is left out and never admitted. */
const facts = (nodes: unknown[]) => nodes.flatMap(node => { try { return [issueFacts(node)]; } catch { return []; } });

/** Linear reads and comment writes for intake. The service re-checks every fact it gets back. */
export class IntakeLinear {
  constructor(private readonly linear: Pick<LinearService, "request">) {}

  /**
   * Issues that may qualify. The query narrows by team, label, creation time, and an open state, leaves archived issues
   * out, and reads up to 10 pages of 200. `capped` is true when more pages remain; the caller re-checks each issue.
   */
  async candidates(filter: { teamIds: string[]; label: string; createdAfter: string }): Promise<{ issues: IntakeIssue[]; capped: boolean }> {
    const variables = {
      filter: { team: { id: { in: filter.teamIds } }, labels: { some: { name: { eqIgnoreCase: filter.label } } }, createdAt: { gt: filter.createdAfter },
        state: { type: { nin: ["completed", "canceled"] } } },
      first: candidatePage,
    };
    const page = z.object({ issues: z.object({
      nodes: z.array(z.unknown()).max(candidatePage),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(1024).nullable() }),
    }) });
    const nodes: unknown[] = [];
    let after: string | undefined;
    for (let read = 0; read < candidatePages; read++) {
      const data = await this.linear.request("InfiniteIntakeCandidates",
        `query InfiniteIntakeCandidates($filter: IssueFilter!, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`,
        { ...variables, ...(after ? { after } : {}) });
      const { issues } = page.parse(data);
      nodes.push(...issues.nodes);
      if (!issues.pageInfo.hasNextPage) return { issues: facts(nodes), capped: false };
      if (!issues.pageInfo.endCursor || issues.pageInfo.endCursor === after) throw new Error("Linear returned a page without a new cursor.");
      after = issues.pageInfo.endCursor;
    }
    return { issues: facts(nodes), capped: true };
  }

  /**
   * The current state of each issue. `deleted` only when Linear answered for that ID and returned no node. A node that
   * fails `issueFacts` is left out of the map, so its issue changes nothing this cycle. A failed request throws.
   */
  async states(issueIds: string[]): Promise<Map<string, IntakeIssue | "deleted">> {
    const result = new Map<string, IntakeIssue | "deleted">();
    for (let index = 0; index < issueIds.length; index += 100) {
      const chunk = issueIds.slice(index, index + 100);
      const data = await this.linear.request("InfiniteIntakeIssueStates",
        `query InfiniteIntakeIssueStates($filter: IssueFilter!, $first: Int!) { issues(filter: $filter, includeArchived: true, first: $first) { nodes { ${issueFields} } } }`,
        { filter: { id: { in: chunk } }, first: chunk.length });
      const nodes = z.object({ issues: z.object({ nodes: z.array(z.unknown()).max(chunk.length) }) }).parse(data).issues.nodes;
      const answered = new Set<string>(), found = new Map<string, IntakeIssue>();
      for (const node of nodes) {
        const id = z.object({ id: z.string() }).safeParse(node).data?.id;
        if (id === undefined || !chunk.includes(id)) continue;
        answered.add(id);
        try { found.set(id, issueFacts(node)); } catch { /* left out of the map: this issue is unchanged this cycle */ }
      }
      for (const id of chunk) {
        const facts = found.get(id);
        if (facts) result.set(id, facts);
        else if (!answered.has(id)) result.set(id, "deleted");
      }
    }
    return result;
  }

  /**
   * Creates the comment under the client-supplied ID. A send that fails is checked by reading the ID back, so a lost
   * response that still committed resolves, and a retry never posts a second copy.
   */
  async comment(issueId: string, input: { id: string; body: string }): Promise<void> {
    let sent = false;
    try {
      const data = await this.linear.request("InfiniteIntakeCommentCreate",
        "mutation InfiniteIntakeCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body issue { id } } } }",
        { input: { id: input.id, issueId, body: input.body } });
      sent = z.object({ commentCreate: z.object({ success: z.literal(true), comment }) }).parse(data).commentCreate.comment.id === input.id;
    } catch { sent = false; }
    if (sent) return;
    const data = await this.linear.request("InfiniteIntakeComment",
      "query InfiniteIntakeComment($filter: CommentFilter!) { comments(filter: $filter, includeArchived: true, first: 1) { nodes { id body issue { id } } } }",
      { filter: { id: { eq: input.id } } });
    const found = z.object({ comments: z.object({ nodes: z.array(comment).max(1) }) }).parse(data).comments.nodes;
    if (!found.some(item => item.id === input.id && item.issue.id === issueId)) throw new Error("Linear did not confirm the comment.");
  }
}
