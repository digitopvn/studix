/**
 * BM25 ranking over short documents, shared by every knowledge search. Adapted from the BM25 engine of
 * agentkit@9fe46997 (ak-creativity and ak-threejs `scripts/core.py`): same tokenizer rule (lowercase, drop
 * punctuation, words of three or more characters) and the usual k1 = 1.5, b = 0.75.
 */

const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

export interface Bm25Index {
  /** Scores of every document for the query, best first; documents scoring 0 are left out. */
  rank(query: string): Array<{ index: number; score: number }>;
}

export function createBm25Index(documents: readonly string[]): Bm25Index {
  const corpus = documents.map((d) => {
    const tf = new Map<string, number>();
    const tokens = tokenize(d);
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, length: tokens.length };
  });
  const n = corpus.length;
  const avgdl = n === 0 ? 0 : corpus.reduce((sum, d) => sum + d.length, 0) / n;
  const df = new Map<string, number>();
  for (const d of corpus) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => {
    const f = df.get(t) ?? 0;
    return Math.log((n - f + 0.5) / (f + 0.5) + 1);
  };

  return {
    rank(query) {
      const terms = [...new Set(tokenize(query))].filter((t) => df.has(t));
      const scored = corpus.map((d, index) => {
        let score = 0;
        for (const t of terms) {
          const tf = d.tf.get(t) ?? 0;
          if (tf === 0) continue;
          score += (idf(t) * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / (avgdl || 1)));
        }
        return { index, score };
      });
      return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    },
  };
}
