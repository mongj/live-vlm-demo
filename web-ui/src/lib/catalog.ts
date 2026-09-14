import { getCatalogUrl } from "@/lib/gateway";
import { asJsonSchema, type JsonSchema } from "@/lib/json-schema";

export type CatalogModel = {
  id: string;
  label: string;
  config_schema: JsonSchema;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModel(value: unknown): CatalogModel | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  if (typeof value.label !== "string" || value.label.length === 0) {
    return null;
  }
  return {
    id: value.id,
    label: value.label,
    config_schema: asJsonSchema(value.config_schema),
  };
}

async function readCatalog(url: string): Promise<CatalogModel[]> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Catalog request failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error("Catalog response was missing models");
  }
  const models = body.models.map(parseModel).filter((model): model is CatalogModel => model !== null);
  if (models.length === 0) {
    throw new Error("Catalog did not return any models");
  }
  return models;
}

export async function fetchCatalog(): Promise<CatalogModel[]> {
  return readCatalog(getCatalogUrl());
}
