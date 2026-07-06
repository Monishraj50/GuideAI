// Stopword list used by the S8 decomposer to filter noisy sub-feature
// candidates (single-word connectives, generic verbs, framework nouns that
// don't warrant their own task). Kept in its own file so the main
// `decompose.ts` stays readable.

export const STOPWORDS_LARGE = new Set<string>([
  // Connective words + filler. Kept intentionally narrow — "add", "done",
  // "list" etc. are stop-words for a search index but VALUABLE names for
  // commands / features, so we let them through here. The decomposer relies
  // on them being distinct sub-features (e.g. "add/list/done" → 3 tasks).
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'with', 'in', 'on', 'by',
  'as', 'is', 'it', 'be', 'this', 'that', 'we', 'our', 'your', 'their', 'from',
  'should', 'would', 'could', 'want', 'need', 'let', 'any', 'some', 'all',
  'use', 'using', 'not', 'so', 'but', 'if', 'then', 'when', 'while',
  'feature', 'features', 'support', 'supports',
]);
