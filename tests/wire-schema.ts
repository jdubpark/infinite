import { isDeepStrictEqual } from "node:util";

const DRAFT_7 = "http://json-schema.org/draft-07/schema#";
const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "pattern", "format", "minimum", "maximum"]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function unsupported(at: string, what: string): never {
  throw new Error(`wire-schema: ${what} at ${at} is not implemented by this checker`);
}

function assertSupported(schema: unknown, at: string, root: boolean): asserts schema is Schema {
  if (!isObject(schema)) unsupported(at, "a non-object schema");
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === "$schema" && root && value === DRAFT_7) continue;
    if (!KEYWORDS.has(keyword)) unsupported(at, `keyword ${JSON.stringify(keyword)}`);
    if (keyword === "type" && !(typeof value === "string" && TYPES.has(value))) unsupported(at, `type ${JSON.stringify(value)}`);
    if (keyword === "format" && value !== "uuid") unsupported(at, `format ${JSON.stringify(value)}`);
    if (keyword === "additionalProperties" && value !== false) unsupported(at, "additionalProperties other than false");
    if (keyword === "required" && !(Array.isArray(value) && value.every(item => typeof item === "string"))) unsupported(at, "a required list that is not strings");
    if (keyword === "enum" && !Array.isArray(value)) unsupported(at, "an enum that is not a list");
    if (keyword === "pattern" && typeof value !== "string") unsupported(at, "a pattern that is not a string");
    if ((keyword === "minimum" || keyword === "maximum") && typeof value !== "number") unsupported(at, `a ${keyword} that is not a number`);
    if (keyword === "properties") {
      if (!isObject(value)) unsupported(at, "properties that are not an object");
      for (const [name, property] of Object.entries(value)) assertSupported(property, `${at}.properties.${name}`, false);
    }
    if (keyword === "items") assertSupported(value, `${at}.items`, false);
    if (keyword === "anyOf") {
      if (!Array.isArray(value) || value.length === 0) unsupported(at, "an anyOf that is not a list");
      value.forEach((branch, index) => assertSupported(branch, `${at}.anyOf.${index}`, false));
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function refusals(schema: Schema, value: unknown, at: string): string[] {
  const found: string[] = [];
  const kind = typeOf(value);
  if (schema.type !== undefined && schema.type !== kind && !(schema.type === "number" && kind === "integer")) {
    return [`${at}: expected ${String(schema.type)}, got ${kind}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => isDeepStrictEqual(item, value))) found.push(`${at}: not one of the enum values`);
  if ("const" in schema && !isDeepStrictEqual(schema.const, value)) found.push(`${at}: not the const value`);
  if (Array.isArray(schema.anyOf) && schema.anyOf.every(branch => refusals(branch as Schema, value, at).length > 0)) found.push(`${at}: matches no anyOf branch`);
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) found.push(`${at}: does not match the pattern`);
    if (schema.format === "uuid" && !UUID.test(value)) found.push(`${at}: not a uuid`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) found.push(`${at}: below the minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) found.push(`${at}: above the maximum`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => found.push(...refusals(schema.items as Schema, item, `${at}[${index}]`)));
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(value, name)) found.push(`${at}.${name}: required and missing`);
    }
    for (const [name, field] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) found.push(...refusals(properties[name] as Schema, field, `${at}.${name}`));
      else if (schema.additionalProperties === false) found.push(`${at}.${name}: not a declared property`);
    }
  }
  return found;
}

export function schemaRefusals(schema: unknown, value: unknown): string[] {
  assertSupported(schema, "$", true);
  return refusals(schema, value, "$");
}
