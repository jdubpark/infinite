/**
 * Renders a tool's declared JSON Schema (draft-7, from `z.toJSONSchema`) as the type text a Codex member reads in its
 * tool signatures. The text comes from the schema, so a schema change reaches the prompt without a hand edit.
 */
type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The type text of one schema. Anything this renderer does not model is `unknown`, which is never wrong, only less exact. */
export function schemaType(schema: unknown): string {
  if (!isSchema(schema)) return "unknown";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map(value => JSON.stringify(value)).join("|");
  for (const key of ["anyOf", "oneOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members) && members.length > 0) return members.map(schemaType).join("|");
  }
  // zod writes a nullable field and a union of primitives as a type list: the type is the union of its members.
  if (Array.isArray(schema.type)) return schema.type.map(type => schemaType({ ...schema, type })).join("|");
  switch (schema.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      // Object elements keep the brace form; a union of primitives needs parentheses before the `[]`.
      const item = schemaType(schema.items);
      if (item.startsWith("{")) return `Array<${item}>`;
      return item.includes("|") ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const properties = schema.properties;
      if (!isSchema(properties) || Object.keys(properties).length === 0) return "unknown";
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const fields = Object.entries(properties).map(([name, value]) => `${IDENTIFIER.test(name) ? name : JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(value)}`);
      return `{ ${fields.join(", ")} }`;
    }
    default: return "unknown";
  }
}

/**
 * One signature sentence for a tool, in the form a program calls it: `args` is the argument list text, such as
 * `{ report }`, and the result's `structuredContent` type comes from the tool's declared output schema. The type is
 * the result of a successful call; the caller says what a failed call returns.
 */
export function toolSignature(server: string, tool: string, args: string, outputSchema: unknown): string {
  return `await tools.mcp__${server}__${tool}(${args}) returns { structuredContent: ${schemaType(outputSchema)} }.`;
}
