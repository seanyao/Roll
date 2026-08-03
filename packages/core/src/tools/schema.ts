import type { JsonSchema, JsonSchemaTypeName } from "@roll/spec";

export interface SchemaValidationResult {
  ok: boolean;
  errors: readonly string[];
}

export function validateJsonSchemaValue(schema: JsonSchema | undefined, value: unknown): SchemaValidationResult {
  if (schema === undefined) return { ok: true, errors: [] };
  const errors = validate(schema, value, "$");
  return { ok: errors.length === 0, errors };
}

export function schemaParameterSummary(schema: JsonSchema | undefined): string {
  if (schema === undefined || typeof schema === "boolean") return schema === false ? "never" : "-";
  if (schema.type !== "object" || schema.properties === undefined) return schemaTypeLabel(schema);
  const required = new Set(schema.required ?? []);
  const names = Object.keys(schema.properties).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return "{}";
  return names.map((name) => `${name}${required.has(name) ? "" : "?"}`).join(", ");
}

export function schemaTypeLabel(schema: JsonSchema | undefined): string {
  if (schema === undefined) return "-";
  if (typeof schema === "boolean") return schema ? "any" : "never";
  if (schema.oneOf !== undefined) return "oneOf";
  if (schema.anyOf !== undefined) return "anyOf";
  if (Array.isArray(schema.type)) return schema.type.join("|");
  return String(schema.type ?? "object");
}

function validate(schema: JsonSchema, value: unknown, path: string): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path} is not allowed`];

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) return [`${path} must equal ${JSON.stringify(schema.const)}`];
  if (schema.enum !== undefined && !schema.enum.some((item) => jsonEqual(value, item))) return [`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`];

  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => validate(candidate, value, path).length === 0).length;
    return matches === 1 ? [] : [`${path} must match exactly one schema`];
  }
  if (schema.anyOf !== undefined) {
    return schema.anyOf.some((candidate) => validate(candidate, value, path).length === 0) ? [] : [`${path} must match at least one schema`];
  }

  const typeErrors = validateType(schema.type, value, path);
  if (typeErrors.length > 0) return typeErrors;

  const errors: string[] = [];
  if (isRecord(value)) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key];
      if (child !== undefined) errors.push(...validate(child, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) errors.push(...validate(schema.additionalProperties, item, `${path}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
    if (schema.items !== undefined) value.forEach((item, index) => errors.push(...validate(schema.items as JsonSchema, item, `${path}[${index}]`)));
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} must have length >= ${schema.minLength}`);
  if (typeof value === "string" && schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} must have length <= ${schema.maxLength}`);
  if (typeof value === "string" && schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path} must match ${schema.pattern}`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  return errors;
}

function validateType(type: JsonSchemaTypeName | readonly JsonSchemaTypeName[] | undefined, value: unknown, path: string): string[] {
  if (type === undefined) return [];
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => typeMatches(candidate, value)) ? [] : [`${path} must be ${types.join("|")}`];
}

function typeMatches(type: JsonSchemaTypeName, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
