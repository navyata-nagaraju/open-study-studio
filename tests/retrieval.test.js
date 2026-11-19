import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, tokens, retrieve } from "../js/retrieval.js";

test("chunk keeps every word and respects the size limit", () => {
  const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} about gradient descent and learning rates.`).join("\n\n");
  const parts = chunk(text, 300);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 450));
  assert.equal(parts.join(" ").match(/Paragraph/g).length, 50);
});

test("tokens drops short and common words", () => {
  assert.deepEqual(tokens("The cat is on the Mat with a Dropout layer"), ["cat", "mat", "dropout", "layer"]);
});

test("retrieve ranks the chunk that matches the topic first", () => {
  const files = {
    f1: { moduleId: "dl", name: "week1.pdf", chunks: ["Dropout randomly switches off neurons during training to reduce overfitting.", "Batch normalisation rescales layer inputs."] },
    f2: { moduleId: "dl", name: "week2.pdf", chunks: ["Convolutions slide a small filter over an image."] },
    f3: { moduleId: "other", name: "stats.pdf", chunks: ["Dropout is mentioned here but this is another module."] },
  };
  const hits = retrieve(files, "dl", "dropout overfitting", 2);
  assert.equal(hits[0].file, "week1.pdf");
  assert.match(hits[0].text, /Dropout/);
  assert.ok(hits.every((h) => h.file !== "stats.pdf"), "only searches the chosen module");
});

test("retrieve returns nothing when no notes match", () => {
  assert.deepEqual(retrieve({}, "dl", "anything"), []);
});
