/**
 * Finding tables by name (the canvas search box).
 */
export interface SearchCandidate {
  id: string;
  /** What the user sees and types against, e.g. "public.users". */
  label: string;
}

/** How well `text` matches the query: lower is better, null means no match. */
function matchRank(text: string, query: string): number | null {
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  if (text.split(/[._\-\s]/).some((word) => word.startsWith(query))) return 2; // start of a word, e.g. "items" in "order_items"
  if (text.includes(query)) return 3;
  return null;
}

/**
 * Lower is better. The TABLE NAME (the part after the schema) is matched first,
 * because that is what people type: "users" should find the table `users`
 * before `daily_users`. If only the full label ("public.us") matches, the
 * result ranks after every table-name match.
 */
function score(label: string, query: string): number | null {
  const name = label.slice(label.lastIndexOf(".") + 1).toLowerCase();
  const byName = matchRank(name, query);
  if (byName !== null) return byName;
  const byLabel = matchRank(label.toLowerCase(), query);
  return byLabel === null ? null : 4 + byLabel;
}

/**
 * Best matches first, at most `limit`. A blank query matches nothing (the UI
 * shows no suggestions until the user types).
 */
export function searchTables<T extends SearchCandidate>(
  query: string,
  candidates: readonly T[],
  limit = 8,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  return candidates
    .flatMap((candidate) => {
      const s = score(candidate.label, needle);
      return s === null ? [] : [{ candidate, s }];
    })
    .sort((a, b) => a.s - b.s || a.candidate.label.localeCompare(b.candidate.label))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
