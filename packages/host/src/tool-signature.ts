type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function schemaType(schema: unknown): string {
  if (!isSchema(schema)) return "unknown";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map(value => JSON.stringify(value)).join("|");
  for (const key of ["anyOf", "oneOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members) && members.length > 0) return members.map(schemaType).join("|");
  }
  if (Array.isArray(schema.type)) return schema.type.map(type => schemaType({ ...schema, type })).join("|");
  switch (schema.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
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

export function toolSignature(server: string, tool: string, args: string, outputSchema: unknown): string {
  return `await tools.mcp__${server}__${tool}(${args}) returns { structuredContent: ${schemaType(outputSchema)} }.`;
}
