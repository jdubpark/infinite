import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../packages/remote/src/markdown.js";
import type { Inline, RichNode } from "../packages/remote/src/understanding-work.js";

test("headings, paragraphs and emphasis", () => {
  const { nodes } = parseMarkdown("# Title\n\nSome **bold** and *italic* with `code`.");
  assert.deepEqual(nodes[0], { type: "heading", level: 1, inlines: [{ type: "text", text: "Title" }] });
  assert.deepEqual(nodes[1], { type: "paragraph", inlines: [
    { type: "text", text: "Some " }, { type: "text", text: "bold", bold: true }, { type: "text", text: " and " },
    { type: "text", text: "italic", italic: true }, { type: "text", text: " with " }, { type: "code", text: "code" }, { type: "text", text: "." } ] });
});

test("nested lists keep nesting and ordered starts", () => {
  const { nodes } = parseMarkdown("* a\n  * b\n    1. c\n2. d");
  const list = nodes[0] as Extract<RichNode, { type: "list" }>;
  assert.equal(list.type, "list"); assert.equal(list.ordered, false);
  const nested = list.items[0].children[0] as Extract<RichNode, { type: "list" }>;
  assert.equal(nested.type, "list");
  const deeper = nested.items[0].children[0] as Extract<RichNode, { type: "list" }>;
  assert.equal(deeper.type, "list");
  assert.equal(deeper.ordered, true);
  const followingList = nodes[1] as Extract<RichNode, { type: "list" }>;
  assert.equal(followingList.type, "list"); assert.equal(followingList.start, 2);
});

test("fenced code keeps hash lines as code", () => {
  const { nodes } = parseMarkdown("```sh\n# not a heading\nnpm test\n```");
  assert.deepEqual(nodes, [{ type: "code", language: "sh", text: "# not a heading\nnpm test" }]);
});

test("links: https only, bare https autolinked, other schemes stay text", () => {
  const { nodes } = parseMarkdown("See [docs](https://example.invalid/a) and https://example.invalid/b and [x](javascript:alert(1)) and file:///etc");
  const inlines = (nodes[0] as { inlines: Inline[] }).inlines;
  assert.deepEqual(inlines.filter(i => i.type === "link"), [{ type: "link", text: "docs", url: "https://example.invalid/a" }, { type: "link", text: "https://example.invalid/b", url: "https://example.invalid/b" }]);
  assert.ok(inlines.some(i => i.type === "text" && i.text.includes("x")));
});

test("http links remain text", () => {
  const { nodes } = parseMarkdown("[old](http://example.invalid/c)");
  const inlines = (nodes[0] as { inlines: Inline[] }).inlines;
  assert.ok(inlines.every(i => i.type === "text"));
});

test("quotes, rules and pipe tables", () => {
  const { nodes } = parseMarkdown("> quoted\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |");
  assert.equal(nodes[0].type, "quote"); assert.equal(nodes[1].type, "rule");
  assert.equal(nodes[2].type, "paragraph"); // table rows become paragraphs: "a · b" then "1 · 2"
  assert.deepEqual(nodes[0], { type: "quote", children: [{ type: "paragraph", inlines: [{ type: "text", text: "quoted" }] }] });
  assert.deepEqual(nodes[1], { type: "rule" });
  assert.deepEqual(nodes[2], { type: "paragraph", inlines: [{ type: "text", text: "a · b" }] });
  assert.deepEqual(nodes[3], { type: "paragraph", inlines: [{ type: "text", text: "1 · 2" }] });
});

test("bounds: maxNodes truncates and reports; huge input does not throw", () => {
  const { nodes, truncated } = parseMarkdown(Array.from({ length: 50 }, (_, i) => `para ${i}`).join("\n\n"), { maxNodes: 10 });
  assert.equal(nodes.length, 10); assert.equal(truncated, true);
  assert.doesNotThrow(() => parseMarkdown("x".repeat(600 * 1024)));
});

test("zero bounds produce no nodes and report truncation", () => {
  assert.deepEqual(parseMarkdown("content", { maxNodes: 0 }), { nodes: [], truncated: true });
  assert.deepEqual(parseMarkdown("content", { maxBytes: 0 }), { nodes: [], truncated: true });
});

test("headings keep hashes in text, strip closing hashes, and clamp deep levels", () => {
  const { nodes } = parseMarkdown("# C#\n## title ##\n##### Deep");
  assert.deepEqual(nodes, [
    { type: "heading", level: 1, inlines: [{ type: "text", text: "C#" }] },
    { type: "heading", level: 2, inlines: [{ type: "text", text: "title" }] },
    { type: "heading", level: 4, inlines: [{ type: "text", text: "Deep" }] },
  ]);
});

test("asterisk emphasis works inside words while underscore emphasis does not", () => {
  const { nodes } = parseMarkdown("pre*fix*post pre_fix_post _part_one_");
  assert.deepEqual(nodes, [{ type: "paragraph", inlines: [
    { type: "text", text: "pre" }, { type: "text", text: "fix", italic: true },
    { type: "text", text: "post pre_fix_post " }, { type: "text", text: "part_one", italic: true },
  ] }]);
});

test("fenced code in a list preserves code and the following item", () => {
  const { nodes } = parseMarkdown("- before\n\n  ```text\n  code line\n  ```\n\n- after");
  const list = nodes[0] as Extract<RichNode, { type: "list" }>;
  assert.equal(list.type, "list");
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0].children, [{ type: "code", language: "text", text: "code line" }]);
  assert.deepEqual(list.items[1].inlines, [{ type: "text", text: "after" }]);
});

test("fenced code survives ordered-list indentation and multiple blank lines", () => {
  const { nodes } = parseMarkdown("10. before\n\n    ```text\n    a\n\n\n    b\n    ```\n\n11. after");
  const list = nodes[0] as Extract<RichNode, { type: "list" }>;
  assert.equal(list.type, "list");
  assert.equal(list.start, 10);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0].children, [{ type: "code", language: "text", text: "a\n\n\nb" }]);
  assert.deepEqual(list.items[1].inlines, [{ type: "text", text: "after" }]);
});

test("ordered list start preserves zero", () => {
  const { nodes } = parseMarkdown("0. first\n1. second");
  const list = nodes[0] as Extract<RichNode, { type: "list" }>;
  assert.equal(list.type, "list");
  assert.equal(list.start, 0);
});

test("fenced code preserves CRLF line endings", () => {
  const { nodes } = parseMarkdown("```text\r\nline one\r\nline two\r\n```");
  assert.deepEqual(nodes, [{ type: "code", language: "text", text: "line one\r\nline two" }]);
});

test("indented code is emitted as a code node", () => {
  const { nodes } = parseMarkdown("    const answer = 42;\n    return answer;");
  assert.deepEqual(nodes, [{ type: "code", language: null, text: "const answer = 42;\nreturn answer;" }]);
});

test("indented code keeps blank lines within one block", () => {
  const { nodes } = parseMarkdown("    first\n\n\n    second");
  assert.deepEqual(nodes, [{ type: "code", language: null, text: "first\n\n\nsecond" }]);
});

test("tab-indented code is emitted as a code node", () => {
  const { nodes } = parseMarkdown("\tconst answer = 42;");
  assert.deepEqual(nodes, [{ type: "code", language: null, text: "const answer = 42;" }]);
});

test("byte cap truncates UTF-8 input and reports truncation", () => {
  const { nodes, truncated } = parseMarkdown("ééé", { maxBytes: 4 });
  assert.equal(truncated, true);
  assert.deepEqual(nodes, [{ type: "paragraph", inlines: [{ type: "text", text: "éé" }] }]);
});

test("maxNodes counts nested nodes", () => {
  const { nodes, truncated } = parseMarkdown("* parent\n  * child\n\nfollowing", { maxNodes: 2 });
  const countNodes = (items: RichNode[]): number => items.reduce((count, node) => {
    if (node.type === "list") return count + 1 + node.items.reduce((children, item) => children + countNodes(item.children), 0);
    if (node.type === "quote") return count + 1 + countNodes(node.children);
    return count + 1;
  }, 0);
  assert.equal(nodes[0].type, "list");
  assert.equal(countNodes(nodes), 2);
  assert.equal(truncated, true);
});

test("unterminated inline markers remain literal text", () => {
  const { nodes } = parseMarkdown("**bold start and `code start and [link](https://example.invalid");
  assert.deepEqual(nodes, [{ type: "paragraph", inlines: [{ type: "text", text: "**bold start and `code start and [link](https://example.invalid" }] }]);
});
