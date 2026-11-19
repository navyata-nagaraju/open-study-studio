// retrieval.js — finds the parts of a student's notes that match a topic.
//
// The idea in one sentence: cut the notes into small pieces ("chunks"), then
// score every piece by how many of the topic's important words it contains,
// and send only the best few pieces to the AI model. This is the "retrieval"
// half of RAG (retrieval-augmented generation).
//
// The scoring formula is BM25, the classic search-engine ranking method:
//   - a word counts more if it appears often in the chunk (term frequency),
//   - but with diminishing returns, so repeating a word 20 times isn't 20x better,
//   - a rare word counts more than a common one (inverse document frequency),
//   - and long chunks are slightly penalised so they don't win just by being long.
// These functions are pure (no browser APIs), so they can be tested in Node.

// Split text into chunks of roughly `size` characters, keeping paragraphs whole when possible.
export function chunk(text, size = 1400) {
  text = String(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const out = [];
  let current = "";
  for (const para of text.split(/\n\n/)) {
    if (current && (current + "\n\n" + para).length > size) {
      out.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
    // A single very long paragraph (common in PDF text) is cut into pieces.
    while (current.length > size * 1.5) {
      out.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current) out.push(current);
  return out;
}

const STOP_WORDS = new Set(
  "the a an and or of to in on for with is are was were be by as at it this that from which we can not into its their they these those using use used how what why when".split(" ")
);

// Lowercase words of 3+ letters, without common filler words.
export function tokens(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// Rank every chunk of one module's files against a query and return the top k.
export function retrieve(files, moduleId, query, k = 4, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = [];
  for (const file of Object.values(files)) {
    if (file.moduleId !== moduleId) continue;
    file.chunks.forEach((text, i) => docs.push({ file: file.name, i, text, words: tokens(text) }));
  }
  if (!docs.length) return [];

  const queryWords = [...new Set(tokens(query))];
  const n = docs.length;
  const avgLength = docs.reduce((sum, d) => sum + d.words.length, 0) / n;

  // Document frequency: how many chunks contain each query word.
  const df = {};
  for (const w of queryWords) df[w] = docs.filter((d) => d.words.includes(w)).length;

  for (const d of docs) {
    const tf = {};
    for (const w of d.words) tf[w] = (tf[w] || 0) + 1;
    let score = 0;
    for (const w of queryWords) {
      if (!tf[w]) continue;
      const idf = Math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5));
      score += (idf * (tf[w] * (k1 + 1))) / (tf[w] + k1 * (1 - b + (b * d.words.length) / avgLength));
    }
    d.score = score;
  }
  return docs
    .filter((d) => d.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map(({ file, i, text, score }) => ({ file, i, text, score }));
}

// An evenly spread sample of a module's notes, used when planning the topic list.
export function sampleText(files, moduleId, max = 14000) {
  let out = "";
  for (const file of Object.values(files)) {
    if (file.moduleId !== moduleId) continue;
    const step = Math.max(1, Math.floor(file.chunks.length / 12));
    for (let i = 0; i < file.chunks.length && out.length < max; i += step) {
      out += `\n[${file.name}]\n` + file.chunks[i].slice(0, 1100);
    }
  }
  return out.slice(0, max);
}
