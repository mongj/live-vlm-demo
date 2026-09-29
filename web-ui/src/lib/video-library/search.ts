/** Lowercases and treats runs of spaces, `_` and `-` as one space, so "red car" matches "Red_Car-01". */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

/** Keeps items where any of `fields` contains the query; an empty query keeps everything. */
export function filterBySearch<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly (string | undefined)[]
): readonly T[] {
  const needle = normalizeSearchText(query);
  if (!needle) {
    return items;
  }
  return items.filter((item) =>
    fields(item).some((field) => field !== undefined && normalizeSearchText(field).includes(needle))
  );
}
