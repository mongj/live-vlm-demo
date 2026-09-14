export type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonSchema(value: unknown): JsonSchema {
  return isRecord(value) ? (value as JsonSchema) : {};
}

function lookupRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith("#/")) {
    return {};
  }
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) {
      return {};
    }
    current = current[part];
  }
  return asJsonSchema(current);
}

export function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const seen = new Set<string>();
  let current = schema;
  while (current.$ref) {
    if (seen.has(current.$ref)) {
      break;
    }
    seen.add(current.$ref);
    const resolved = lookupRef(current.$ref, root);
    const rest = { ...current };
    delete rest.$ref;
    current = { ...resolved, ...rest };
  }
  return current;
}

export function schemaType(schema: JsonSchema): string | undefined {
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.find((value) => value !== "null");
  }
  if (schema.enum && schema.enum.length > 0) {
    return "string";
  }
  if (schema.properties) {
    return "object";
  }
  if (schema.const !== undefined) {
    return typeof schema.const;
  }
  return undefined;
}

export function stringEnumValues(schema: JsonSchema): string[] | null {
  if (schema.const !== undefined) {
    return typeof schema.const === "string" ? [schema.const] : null;
  }
  if (!schema.enum || schema.enum.length === 0) {
    return null;
  }
  if (schema.enum.every((value) => typeof value === "string")) {
    return schema.enum as string[];
  }
  return null;
}

export function defaultsFromSchema(schema: JsonSchema): Record<string, unknown> {
  const root = schema;
  const resolved = resolveSchema(schema, root);
  const properties = resolved.properties;
  if (!properties) {
    return {};
  }

  const values: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    const field = resolveSchema(propertySchema, root);
    if (field.default !== undefined) {
      values[key] = field.default;
      continue;
    }

    const enums = stringEnumValues(field);
    const type = schemaType(field);
    switch (type) {
      case "object":
        values[key] = defaultsFromSchema({ ...field, $defs: root.$defs, definitions: root.definitions });
        break;
      case "boolean":
        values[key] = false;
        break;
      case "integer":
      case "number":
        values[key] = field.minimum ?? 0;
        break;
      case "string":
        values[key] = enums?.[0] ?? "";
        break;
      default:
        if (enums?.[0] !== undefined) {
          values[key] = enums[0];
        }
        break;
    }
  }
  return values;
}
