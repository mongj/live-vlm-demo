import { defaultsFromSchema, resolveSchema, type JsonSchema } from "@/lib/json-schema";

export const GENERATION_KEYS = ["decode_mode", "temperature", "top_p", "top_k", "length_penalty"] as const;
export const SAMPLING_KEYS = ["temperature", "top_p", "top_k"] as const;

/** Only group fields actually advertised by this gateway; older catalogs still work. */
export function splitGenerationSchema(modelId: string, schema: JsonSchema) {
  const resolved = resolveSchema(schema, schema);
  if (modelId !== "minicpm-o-4-5") return { basic: schema, advanced: null };
  const properties = resolved.properties ?? {};
  const advanced = Object.fromEntries(GENERATION_KEYS.filter(key => key in properties).map(key => [key, properties[key]]));
  if (!Object.keys(advanced).length) return { basic: schema, advanced: null };
  return {
    basic: { ...resolved, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !(key in advanced))) },
    advanced: { ...resolved, properties: advanced },
  };
}

export function generationDefaults(schema: JsonSchema): Record<string, unknown> {
  const defaults = defaultsFromSchema(schema);
  return Object.fromEntries(GENERATION_KEYS.filter(key => key in defaults).map(key => [key, defaults[key]]));
}

export function generationConfigErrors(modelId: string, schema: JsonSchema, values: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const { advanced } = splitGenerationSchema(modelId, schema);
  for (const [key, raw] of Object.entries(advanced?.properties ?? {})) {
    const field = resolveSchema(raw, schema);
    const value = values[key] === undefined ? field.default : values[key];
    if (field.enum) {
      if (!field.enum.includes(value)) errors[key] = "Select a supported mode.";
    } else if (typeof value !== "number" || !Number.isFinite(value) ||
      (field.type === "integer" && !Number.isInteger(value)) ||
      (field.minimum !== undefined && value < field.minimum) ||
      (field.maximum !== undefined && value > field.maximum)) {
      errors[key] = `Enter ${field.type === "integer" ? "a whole number" : "a number"} from ${field.minimum} to ${field.maximum}.`;
    }
  }
  return errors;
}

/** Detached numeric/enum snapshot only, never the prompt or arbitrary model config. */
export function generationEvidence(modelId: string, schema: JsonSchema, values: Record<string, unknown>) {
  const { advanced } = splitGenerationSchema(modelId, schema);
  if (!advanced || Object.keys(generationConfigErrors(modelId, schema, values)).length) return null;
  const names = { decode_mode: "decodeMode", temperature: "temperature", top_p: "topP", top_k: "topK", length_penalty: "lengthPenalty" };
  const snapshot: Record<string, unknown> = { source: "session_request" };
  for (const key of GENERATION_KEYS) {
    const field = advanced.properties?.[key];
    if (field) snapshot[names[key]] = values[key] === undefined ? resolveSchema(field, schema).default : values[key];
  }
  return snapshot;
}
