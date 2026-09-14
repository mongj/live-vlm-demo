import { Playground } from "@/components/playground";
import { fetchCatalog, type CatalogModel } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default async function Home() {
  let models: CatalogModel[] = [];
  let catalogError: string | null = null;
  try {
    models = await fetchCatalog();
  } catch (error) {
    catalogError = error instanceof Error ? error.message : "Unable to load the model Catalog";
  }

  return <Playground initialCatalogError={catalogError} initialModels={models} />;
}
