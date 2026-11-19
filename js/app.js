// app.js — the user interface. It reads and writes state through store.js,
// asks planner.js what to study, retrieval.js which notes to use, and llm.js
// for the AI's lessons, questions and marking.

import * as store from "./store.js";
import { chunk, retrieve, sampleText } from "./retrieval.js";
import { schedule, isStudyDay, moduleStats, difficulty, recordScore, addDays, isoDate, MINUTES_PER_TOPIC } from "./planner.js";
import { PROVIDERS, complete, completeJson } from "./llm.js";
import { planPrompt, lessonPrompt, checkPrompt, practicePrompt, markPrompt } from "./prompts.js";

/* ---------- small helpers ---------- */
const $ = (s) => document.querySelector(s);
// h("button", {class: "btn", onclick: fn}, "Label") builds a DOM element.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3500);
}
const uid = () => Math.random().toString(36).slice(2, 10);
const TODAY = isoDate(new Date());
const fmt = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LEVEL = ["", "Basics", "Core", "Advanced"];
function md(text) {
  const el = h("div", { class: "md" });
  if (window.marked && window.DOMPurify) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text || ""));
    el.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
  } else for (const p of String(text).split(/\n{2,}/)) el.append(h("p", null, p));
  return el;
}
function saveFile(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- state ---------- */
const S = { settings: null, profile: null, progress: {}, files: {}, plans: {}, bank: {}, view: "today", mod: null, topic: null, step: "learn", draft: null, example: false };
const lessonState = {}; // per-topic lesson text and questions, kept for this visit only

const P = () => S.profile || {};
const modules = () => P().modules || [];
const modById = (id) => modules().find((m) => m.id === id);
const topicsOf = (id) => (S.plans[id] && S.plans[id].topics) || [];
const prog = (id) => S.progress[id] || {};
const hasKey = () => !!(S.settings && S.settings.apiKey);

async function saveProfile(profile) { S.profile = profile; if (!S.example) await store.set("profile", profile); }
async function saveProgress() { if (!S.example) await store.set("progress", S.progress); }

// Every AI call goes through here so missing keys are handled in one place.
function ai(prompt, opts) {
  if (!hasKey()) { go("settings"); return Promise.reject(new Error("Add an AI key in Settings to use the tutor.")); }
  return opts && opts.json ? completeJson(S.settings, prompt, opts) : complete(S.settings, prompt, opts);
}

/* ---------- reading materials ---------- */
let pdfLib = null;
function loadPdfReader() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfLib) pdfLib = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("The PDF reader didn't load. Check your connection or paste the text instead."));
    document.head.append(s);
  });
  return pdfLib;
}
async function readFile(file) {
  if (/\.pdf$/i.test(file.name)) {
    const lib = await loadPdfReader();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      pages.push(content.items.map((i) => i.str).join(" "));
    }
    return pages.join("\n\n");
  }
  if (/\.(txt|md|markdown|csv|vtt|srt)$/i.test(file.name)) {
    // Caption files: drop the numbered timing lines and keep the words.
    return (await file.text()).replace(/\r\n?/g, "\n").replace(/^\d+\n[\d:,.\s>-]+\n/gm, "").replace(/^WEBVTT.*$/m, "");
  }
  throw new Error(file.name + ": use a PDF or a text file, or paste the text.");
}
async function addText(module, name, text) {
  const id = "f" + uid();
  const file = { moduleId: module.id, name, chunks: chunk(text), addedOn: TODAY };
  S.files[id] = file;
  if (!S.example) await store.set("file:" + id, file);
  toast(`Added ${name} (${file.chunks.length} parts)`);
}
async function removeFile(id) { delete S.files[id]; if (!S.example) await store.remove("file:" + id); }

/* ---------- planning a module ---------- */
async function buildPlan(m, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Planning…'; }
  try {
    const reply = await ai(planPrompt(P(), m, sampleText(S.files, m.id)), { json: true, maxTokens: 4000 });
    const list = (reply.topics || []).filter((t) => t && t.title).slice(0, 24);
    if (!list.length) throw new Error("The AI didn't return any topics. Try again.");
    const plan = {
      moduleId: m.id, builtOn: TODAY,
      topics: list.map((t, i) => ({
        id: `${m.id}-${i + 1}-${uid().slice(0, 4)}`,
        title: String(t.title), summary: String(t.summary || ""),
        level: [1, 2, 3].includes(+t.level) ? +t.level : 2,
        keywords: Array.isArray(t.keywords) ? t.keywords.map(String).slice(0, 8) : [],
      })),
    };
    S.plans[m.id] = plan;
    if (!S.example) await store.set("plan:" + m.id, plan);
    toast(`Planned ${list.length} topics for ${m.name}`);
  } catch (e) { toast(e.message); }
  render();
}

/* ---------- navigation ---------- */
const VIEWS = [["today", "Today"], ["modules", "Modules"], ["bank", "Question bank"], ["setup", "Setup"], ["settings", "Settings"]];
function go(view, extra = {}) {
  Object.assign(S, { view }, extra);
  try { history.replaceState(null, "", "#" + (view === "lesson" ? "modules" : view)); } catch (_) {}
  render();
  window.scrollTo({ top: 0 });
}
function renderTabs() {
  $("#tabs").replaceChildren(...VIEWS.map(([id, label]) =>
    h("button", { "aria-current": S.view === id || (id === "modules" && S.view === "lesson") ? "page" : null, onclick: () => go(id) }, label)));
}
function render() {
  renderTabs();
  $("#sync").textContent = S.example ? "Example course" : hasKey() ? "Saved in this browser" : "No AI key yet";
  if (!S.profile && !["setup", "settings"].includes(S.view)) S.view = "setup";
  const view = { today: viewToday, modules: viewModules, lesson: viewLesson, bank: viewBank, setup: viewSetup, settings: viewSettings }[S.view] || viewToday;
  $("#app").replaceChildren(...[].concat(view()));
}

/* ---------- Today ---------- */
function rail() {
  return h("aside", { class: "card" },
    h("div", { class: "eyebrow" }, "Your modules"),
    h("div", { class: "modlist" }, modules().map((m) => {
      const st = moduleStats(S.plans, S.progress, m.id);
      const pct = st.total ? Math.round((100 * st.done) / st.total) : 0;
      return h("button", { "aria-current": S.mod === m.id ? "true" : null, onclick: () => go("modules", { mod: m.id }) },
        h("strong", null, m.name),
        h("div", { class: "bar" }, h("span", { style: `width:${pct}%` })),
        h("div", { class: "meta" }, h("span", null, st.total ? `${st.done}/${st.total} topics` : "Not planned"), h("span", null, m.examDate ? "Exam " + fmt(m.examDate) : "")));
    })),
    h("button", { class: "btn ghost small", onclick: () => go("setup") }, "Edit modules"));
}
function viewToday() {
  const plan = schedule({ profile: P(), plans: S.plans, progress: S.progress, today: TODAY, days: 7 });
  const today = plan[TODAY] || [];
  const unplanned = modules().filter((m) => !S.plans[m.id]);
  const name = (P().name || "").split(" ")[0];
  const main = h("div", { class: "stack" },
    h("div", { class: "stack" },
      h("div", { class: "eyebrow" }, fmt(TODAY)),
      h("h1", null, name ? `${name}, here's today` : "Here's today"),
      h("p", { class: "muted" }, isStudyDay(P(), TODAY)
        ? `${today.length} topic${today.length === 1 ? "" : "s"}, about ${today.length * MINUTES_PER_TOPIC} minutes. Anything you miss moves to your next study day.`
        : "Today is a rest day in your plan.")),
    S.example ? h("div", { class: "banner" }, "This is an example course so you can look around. ", h("button", { class: "btn small", onclick: () => leaveExample() }, "Start my own")) : null,
    !hasKey() && !S.example ? h("div", { class: "banner" }, "The tutor needs an AI key to plan and teach. ", h("button", { class: "btn small", onclick: () => go("settings") }, "Add a key")) : null,
    unplanned.length && hasKey() ? h("div", { class: "banner" }, `${unplanned.map((m) => m.name).join(", ")} ${unplanned.length > 1 ? "have" : "has"} no topics yet. `,
      h("button", { class: "btn small", onclick: async (e) => { for (const m of unplanned) await buildPlan(m, e.target); } }, "Plan now")) : null,
    h("div", { class: "stack" }, today.length ? today.map(taskRow) : h("div", { class: "empty" }, h("p", null, modules().length ? "Nothing scheduled today." : "Add your modules in Setup to get a plan."))),
    h("div", { class: "card" }, h("h3", null, "This week"),
      h("div", { class: "week" }, Object.entries(plan).map(([d, list]) =>
        h("div", { class: "day" + (isStudyDay(P(), d) ? "" : " off") + (d === TODAY ? " today" : "") },
          h("b", null, fmt(d)),
          isStudyDay(P(), d) ? list.map((x) => h("span", null, (x.done ? "✓ " : x.review ? "↻ " : "") + x.t.title)) : h("span", null, (P().offDates || []).includes(d) ? "Busy" : "Rest day"))))),
    busyCard());
  return h("div", { class: "grid" }, rail(), main);
}
function busyCard() {
  const off = P().offDates || [];
  return h("div", { class: "card" },
    h("h3", null, "Can't study on a day?"),
    h("p", { class: "small muted" }, "Mark it and the plan moves that day's topics forward."),
    h("div", { class: "row" },
      h("input", { type: "date", id: "offd", min: TODAY, style: "max-width:200px", "aria-label": "Busy day" }),
      h("button", { class: "btn", onclick: async () => {
        const d = $("#offd").value; if (!d) return;
        await saveProfile({ ...P(), offDates: [...new Set([...off, d])].filter((x) => x >= TODAY).sort() });
        toast("Marked " + fmt(d) + " as busy"); render();
      } }, "Mark busy")),
    off.length ? h("div", { class: "files" }, off.map((d) => h("span", { class: "chip" }, fmt(d),
      h("button", { "aria-label": "Remove " + d, onclick: async () => { await saveProfile({ ...P(), offDates: off.filter((x) => x !== d) }); render(); } }, "×")))) : null);
}
function taskRow(x) {
  const p = prog(x.t.id);
  return h("div", { class: "task" + (x.done ? " done" : "") },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("div", { class: "stack", style: "gap:2px" },
      h("span", { class: "t" }, h("strong", null, x.t.title)),
      h("span", { class: "small muted" }, x.m.name + " · " + (x.review ? `Review: last score ${p.score}%` : x.t.summary))),
    h("button", { class: "btn" + (x.done ? "" : " primary"), onclick: () => go("lesson", { mod: x.m.id, topic: x.t.id, step: "learn" }) }, x.done ? "Revisit" : x.review ? "Review" : "Start"));
}

/* ---------- Modules ---------- */
function viewModules() {
  if (!S.mod && modules()[0]) S.mod = modules()[0].id;
  const m = modById(S.mod);
  if (!m) return h("div", { class: "empty" }, h("p", null, "Add a module in Setup first."), h("button", { class: "btn primary", onclick: () => go("setup") }, "Go to Setup"));
  const topics = topicsOf(m.id);
  const st = moduleStats(S.plans, S.progress, m.id);
  const fileCount = Object.values(S.files).filter((f) => f.moduleId === m.id).length;
  return h("div", { class: "grid" }, rail(), h("div", { class: "stack" },
    h("div", { class: "stack" },
      h("div", { class: "eyebrow" }, m.examDate ? "Exam " + fmt(m.examDate) : "No exam date"),
      h("h1", null, m.name),
      h("p", { class: "muted" }, st.total ? `${st.done} of ${st.total} topics done${st.avg != null ? `, average practice score ${st.avg}%` : ""}. ${fileCount} file${fileCount === 1 ? "" : "s"} uploaded.` : "No topics yet."),
      h("div", { class: "row" }, h("button", { class: "btn" + (topics.length ? "" : " primary"), onclick: (e) => buildPlan(m, e.target) }, topics.length ? "Rebuild topics" : "Plan this module"),
        topics.length ? h("span", { class: "small muted" }, "Rebuild after uploading new materials. Scores on old topics stay in your history.") : null)),
    topics.length ? h("div", { class: "stack" }, topics.map((t, i) => {
      const p = prog(t.id);
      return h("div", { class: "task" + (p.done ? " done" : "") },
        h("span", { class: "lvl" }, LEVEL[t.level]),
        h("div", { class: "stack", style: "gap:2px" }, h("span", { class: "t" }, h("strong", null, `${i + 1}. ${t.title}`)), h("span", { class: "small muted" }, t.summary)),
        h("div", { class: "row" }, p.score != null ? h("span", { class: "chip " + (p.score >= 70 ? "good" : "warn") }, p.score + "%") : null,
          h("button", { class: "btn", onclick: () => go("lesson", { mod: m.id, topic: t.id, step: "learn" }) }, p.done ? "Revisit" : "Open")));
    })) : h("div", { class: "empty" }, h("p", null, "Upload notes or slides in Setup, then plan the module. You can also plan it from the module name alone."))));
}

/* ---------- Lesson: Learn, Check, Practise ---------- */
function viewLesson() {
  const m = modById(S.mod);
  const t = m && topicsOf(m.id).find((x) => x.id === S.topic);
  if (!t) { S.view = "modules"; return viewModules(); }
  const st = lessonState[t.id] || (lessonState[t.id] = {});
  const topics = topicsOf(m.id);
  const idx = topics.findIndex((x) => x.id === t.id);
  const head = h("div", { class: "stack" },
    h("button", { class: "btn ghost small", style: "justify-self:start", onclick: () => go("modules", { mod: m.id }) }, "← " + m.name),
    h("div", { class: "row" }, h("span", { class: "lvl" }, LEVEL[t.level]), h("span", { class: "small muted" }, `Topic ${idx + 1} of ${topics.length}`)),
    h("h1", null, t.title), h("p", { class: "muted" }, t.summary),
    h("div", { class: "steps" }, [["learn", "1 Learn"], ["check", "2 Check understanding"], ["practise", "3 Practise"]].map(([id, label]) =>
      h("button", { "aria-current": S.step === id ? "step" : null, onclick: () => { S.step = id; render(); } }, label))));
  const body = S.step === "learn" ? learnPane(m, t, st) : S.step === "check" ? checkPane(m, t, st) : practisePane(m, t, st);
  return h("div", { class: "lesson card" }, head, body);
}
const retry = (msg, fn) => h("div", { class: "empty" }, h("p", null, msg), h("button", { class: "btn primary", onclick: fn }, "Try again"));

function learnPane(m, t, st) {
  const out = h("div", { class: "stack" });
  if (st.lesson) {
    out.append(md(st.lesson));
    if (st.sources && st.sources.length) out.append(h("p", { class: "src" }, "Based on your notes: " + [...new Set(st.sources)].join(", ")));
    out.append(h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: () => { S.step = "check"; render(); } }, "Check my understanding →"),
      h("button", { class: "btn ghost", onclick: () => { st.lesson = null; render(); } }, "Explain it differently")));
    return out;
  }
  if (st.error) return retry(st.error, () => { st.error = null; render(); });
  out.append(h("div", { id: "stream", class: "md" }, h("p", { class: "muted" }, h("span", { class: "spin" }), " Your tutor is preparing this topic…")));
  if (!st.busy) setTimeout(() => teach(m, t, st), 0);
  return out;
}
async function teach(m, t, st) {
  st.busy = true;
  const extracts = retrieve(S.files, m.id, `${t.title} ${t.keywords.join(" ")} ${t.summary}`);
  st.sources = extracts.map((x) => x.file);
  try {
    st.lesson = await ai(lessonPrompt(P(), m, t, extracts), {
      onText: (text) => { const el = $("#stream"); if (el) { const fresh = md(text); fresh.id = "stream"; el.replaceWith(fresh); } },
    });
  } catch (e) { st.error = e.message; }
  st.busy = false;
  if (S.view === "lesson" && S.topic === t.id && S.step === "learn") render();
}

function checkPane(m, t, st) {
  const out = h("div", { class: "stack" }, h("p", { class: "muted" }, "Three quick questions to check the idea landed. These don't count towards your score."));
  if (st.checkError) return retry(st.checkError, () => { st.checkError = null; render(); });
  if (!st.checks) {
    if (!st.checkBusy) {
      st.checkBusy = true;
      ai(checkPrompt(m, t, st.lesson), { json: true })
        .then((r) => { st.checks = (r.questions || []).filter((q) => q && Array.isArray(q.options)).slice(0, 3); if (!st.checks.length) throw new Error("The questions didn't load."); })
        .catch((e) => { st.checks = null; st.checkError = e.message; })
        .finally(() => { st.checkBusy = false; if (S.step === "check") render(); });
    }
    out.append(h("p", null, h("span", { class: "spin" }), " Writing questions…"));
    return out;
  }
  st.picked = st.picked || {};
  st.checks.forEach((c, qi) => {
    const box = h("div", { class: "q" }, h("strong", null, `${qi + 1}. ${c.q}`));
    c.options.forEach((option, oi) => {
      const chosen = st.picked[qi];
      const cls = chosen == null ? "" : oi === +c.answer ? " right" : oi === chosen ? " wrong" : "";
      box.append(h("label", { class: "opt" + cls },
        h("input", { type: "radio", name: "c" + qi, checked: chosen === oi, disabled: chosen != null, onchange: () => { st.picked[qi] = oi; render(); } }), option));
    });
    if (st.picked[qi] != null) box.append(h("div", { class: "fb" }, (st.picked[qi] === +c.answer ? "Right. " : "Not quite. ") + (c.why || "")));
    out.append(box);
  });
  out.append(h("div", { class: "row" },
    h("button", { class: "btn primary", onclick: () => { S.step = "practise"; render(); } }, "Go to practice →"),
    h("button", { class: "btn ghost", onclick: () => { S.step = "learn"; render(); } }, "Back to the lesson")));
  return out;
}

function practisePane(m, t, st) {
  const level = difficulty(S.plans, S.progress, m.id, t.id);
  const goal = P().goal || "exams";
  const out = h("div", { class: "stack" }, h("p", { class: "muted" },
    `Level ${level} of 5. Practice gets harder as your scores rise. Questions are written in ${goal === "interviews" ? "job interview" : goal === "both" ? "exam and job interview" : "exam"} style.`));
  if (st.qError) return retry(st.qError, () => { st.qError = null; render(); });
  if (!st.qs) {
    if (!st.qBusy) {
      st.qBusy = true;
      const extracts = retrieve(S.files, m.id, `${t.title} ${t.keywords.join(" ")}`, 3);
      ai(practicePrompt(P(), m, t, level, extracts), { json: true })
        .then((r) => { st.qs = (r.questions || []).filter((q) => q && q.q).slice(0, 3); if (!st.qs.length) throw new Error("The questions didn't load."); })
        .catch((e) => { st.qs = null; st.qError = e.message; })
        .finally(() => { st.qBusy = false; if (S.step === "practise") render(); });
    }
    out.append(h("p", null, h("span", { class: "spin" }), " Writing questions…"));
    return out;
  }
  st.answers = st.answers || [];
  st.qs.forEach((q, i) => {
    const box = h("div", { class: "q" }, h("strong", null, `Question ${i + 1}`), md(q.q));
    const ta = h("textarea", { id: `a-${t.id}-${i}`, "aria-label": `Answer ${i + 1}`, placeholder: "Your answer", disabled: !!st.marks, oninput: (e) => { st.answers[i] = e.target.value; } });
    ta.value = st.answers[i] || "";
    box.append(ta);
    if (st.marks) {
      const mk = st.marks[i] || {};
      box.append(h("div", { class: "fb" }, h("strong", null, `${mk.score ?? 0}/10 `), mk.feedback || ""), h("details", null, h("summary", null, "Model answer"), md(q.model)));
    }
    out.append(box);
  });
  if (!st.marks) {
    out.append(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: (e) => markAnswers(m, t, st, e.target) }, "Mark my answers")));
  } else {
    const score = Math.round((st.marks.reduce((a, b) => a + (+b.score || 0), 0) / st.marks.length) * 10);
    const next = topicsOf(m.id)[topicsOf(m.id).findIndex((x) => x.id === t.id) + 1];
    out.append(h("div", { class: "card", style: "background:var(--accent-soft);border-color:transparent" },
      h("div", { class: "row" }, h("span", { class: "score" }, score + "%"), h("span", null, score >= 70 ? "Topic complete. Nice work." : "Topic complete. It will come back for a short review in three days.")),
      h("div", { class: "row" },
        next ? h("button", { class: "btn primary", onclick: () => go("lesson", { mod: m.id, topic: next.id, step: "learn" }) }, "Next topic: " + next.title) : null,
        h("button", { class: "btn", onclick: () => { st.qs = null; st.marks = null; st.answers = []; render(); } }, "Try new questions"),
        h("button", { class: "btn ghost", onclick: () => go("today") }, "Back to today"))));
  }
  return out;
}
async function markAnswers(m, t, st, btn) {
  if (!st.answers.some((a) => a && a.trim())) { toast("Write at least one answer first"); return; }
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Marking…';
  try {
    const r = await ai(markPrompt(st.qs, st.answers), { json: true });
    const marks = (r.marks || []).slice(0, st.qs.length);
    // Only lock the answers once real marks have arrived, so an empty reply can be retried.
    if (!marks.length) throw new Error("The marking didn't come back. Press Mark my answers again.");
    st.marks = marks;
    const score = Math.round((marks.reduce((a, b) => a + (+b.score || 0), 0) / marks.length) * 10);
    S.progress = recordScore(S.progress, t.id, score, TODAY);
    await saveProgress();
    const bank = (S.bank[m.id] && S.bank[m.id].items) || [];
    S.bank[m.id] = { moduleId: m.id, items: [...bank, ...st.qs.map((q) => ({ topic: t.title, q: q.q, a: q.model, on: TODAY }))].slice(-500) };
    if (!S.example) await store.set("bank:" + m.id, S.bank[m.id]);
  } catch (e) { toast(e.message); }
  render();
}

/* ---------- Question bank ---------- */
function viewBank() {
  const withQs = modules().filter((m) => S.bank[m.id] && S.bank[m.id].items.length);
  const page = h("div", { class: "stack" }, h("h1", null, "Question bank"), h("p", { class: "muted" }, "Every practice question you've answered, with model answers. Use it for revision."));
  if (!withQs.length) { page.append(h("div", { class: "empty" }, h("p", null, "Questions appear here after your first practice round."))); return page; }
  for (const m of withQs) {
    const items = S.bank[m.id].items;
    page.append(h("div", { class: "card" },
      h("div", { class: "row" }, h("h2", { style: "margin-right:auto" }, m.name), h("span", { class: "small muted" }, items.length + " questions"),
        h("button", { class: "btn", onclick: () => saveFile(m.name.replace(/[^\w-]+/g, "_") + "_questions.md",
          `# ${m.name}: question bank\n\n` + items.map((it, i) => `## ${i + 1}. ${it.topic}\n\n${it.q}\n\n**Model answer**\n\n${it.a || ""}\n`).join("\n---\n\n"), "text/markdown") }, "Download")),
      ...items.slice().reverse().map((it) => h("details", null, h("summary", null, it.topic + ": " + it.q.replace(/[#*`]/g, "").slice(0, 120)), md(it.q), h("div", { class: "fb" }, md(it.a || ""))))));
  }
  return page;
}

/* ---------- Setup ---------- */
function viewSetup() {
  const base = { name: "", programme: "", level: "Master's", goal: "both", minutesPerDay: 90, studyDays: [1, 2, 3, 4, 5, 6], background: "", modules: [] };
  const d = S.draft || (S.draft = JSON.parse(JSON.stringify({ ...base, ...(S.profile || {}) })));
  const field = (id, label, hint, input) => h("label", { for: id }, label, hint ? h("span", { class: "hint" }, hint) : null, input);
  const text = (k, type = "text", extra = {}) => h("input", { id: "p-" + k, type, value: d[k] ?? "", oninput: (e) => { d[k] = type === "number" ? +e.target.value : e.target.value; }, ...extra });
  const bg = h("textarea", { id: "p-background", oninput: (e) => { d.background = e.target.value; } });
  bg.value = d.background || "";
  return h("div", { class: "stack", style: "max-width:820px" },
    h("div", { class: "stack" },
      h("div", { class: "eyebrow" }, S.profile && !S.example ? "Setup" : "Welcome"),
      h("h1", null, S.profile && !S.example ? "Your course" : "Set up your study plan"),
      h("p", { class: "muted" }, "Tell the tutor about your course and upload your lecture notes or slides. It turns them into a daily plan and teaches each topic from the basics. You can change anything here later.")),
    !S.profile ? h("div", { class: "row" }, h("button", { class: "btn", onclick: enterExample }, "Look around an example course first")) : null,
    h("div", { class: "card" }, h("h3", null, "About you"),
      h("div", { class: "two" },
        field("p-name", "Your name", null, text("name")),
        field("p-programme", "Course or programme", "e.g. MSc Data Science", text("programme")),
        field("p-level", "Level", null, h("select", { id: "p-level", onchange: (e) => { d.level = e.target.value; } }, ["Undergraduate", "Master's", "PhD", "Professional course"].map((x) => h("option", { selected: d.level === x }, x)))),
        field("p-goal", "Studying for", null, h("select", { id: "p-goal", onchange: (e) => { d.goal = e.target.value; } }, [["exams", "Exams"], ["interviews", "Job interviews"], ["both", "Both"]].map(([v, l]) => h("option", { value: v, selected: d.goal === v }, l))))),
      field("p-background", "What you already know", "A sentence or two. The tutor pitches explanations to this.", bg)),
    h("div", { class: "card" }, h("h3", null, "Your time"),
      h("div", { class: "two" }, field("p-minutesPerDay", "Minutes a day", `About ${MINUTES_PER_TOPIC} minutes per topic`, text("minutesPerDay", "number", { min: 20, max: 480, step: 5 }))),
      h("div", { class: "stack" }, h("span", { style: "font-weight:600;font-size:.9rem" }, "Study days"),
        h("div", { class: "days" }, [1, 2, 3, 4, 5, 6, 0].map((day) => h("label", null,
          h("input", { type: "checkbox", checked: d.studyDays.includes(day), onchange: (e) => { d.studyDays = e.target.checked ? [...new Set([...d.studyDays, day])] : d.studyDays.filter((x) => x !== day); } }), DOW[day]))))),
    h("div", { class: "card" },
      h("div", { class: "row" }, h("h3", { style: "margin-right:auto" }, "Modules"), h("button", { class: "btn", onclick: () => { d.modules.push({ id: "m" + uid(), name: "", examDate: "", priority: "normal" }); render(); } }, "Add module")),
      d.modules.length ? null : h("p", { class: "muted small" }, "Add each module or subject you're studying."),
      ...d.modules.map((m, i) => moduleEditor(d, m, i))),
    h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: (e) => saveSetup(d, e.target) }, S.profile && !S.example ? "Save changes" : "Create my plan"),
      S.profile ? h("button", { class: "btn ghost", onclick: () => { S.draft = null; go("today"); } }, "Cancel") : null));
}
function moduleEditor(d, m, i) {
  const files = Object.entries(S.files).filter(([, f]) => f.moduleId === m.id);
  return h("div", { class: "mod" },
    h("label", { for: "mn-" + m.id }, "Module name", h("input", { id: "mn-" + m.id, value: m.name, placeholder: "e.g. Machine Learning", oninput: (e) => { m.name = e.target.value; } })),
    h("label", { for: "me-" + m.id }, "Exam or deadline", h("input", { id: "me-" + m.id, type: "date", value: m.examDate || "", onchange: (e) => { m.examDate = e.target.value; } })),
    h("button", { class: "btn ghost", onclick: () => { d.modules.splice(i, 1); render(); } }, "Remove"),
    h("div", { style: "grid-column:1/-1", class: "stack" },
      h("div", { class: "files" }, files.map(([id, f]) => h("span", { class: "chip" }, `${f.name} · ${f.chunks.length} parts`,
        h("button", { "aria-label": "Remove " + f.name, onclick: async () => { await removeFile(id); render(); } }, "×"))),
        files.length ? null : h("span", { class: "small muted" }, "No materials yet")),
      h("div", { class: "row" },
        h("label", { class: "btn", style: "display:inline-flex;cursor:pointer" }, "Upload PDF or text",
          h("input", { type: "file", multiple: true, accept: ".pdf,.txt,.md,.vtt,.srt", hidden: true, onchange: (e) => upload(m, [...e.target.files]) })),
        h("button", { class: "btn ghost", onclick: (e) => {
          const name = h("input", { placeholder: "Name, e.g. Week 3 notes", "aria-label": "Name for pasted text" });
          const ta = h("textarea", { placeholder: "Paste notes or a lecture transcript", "aria-label": "Pasted text" });
          e.target.replaceWith(h("div", { class: "stack", style: "width:100%" }, name, ta,
            h("div", { class: "row" }, h("button", { class: "btn primary", onclick: async () => { if (!ta.value.trim()) return; await addText(m, name.value || "Pasted notes", ta.value); render(); } }, "Add text"))));
        } }, "Paste text"))));
}
async function upload(m, files) {
  for (const file of files) {
    toast("Reading " + file.name + "…");
    try {
      const text = await readFile(file);
      if (!text.trim()) throw new Error(file.name + " has no readable text. Scanned PDFs need to be pasted as text.");
      await addText(m, file.name, text);
    } catch (e) { toast(e.message); }
  }
  render();
}
async function saveSetup(d, btn) {
  d.modules = d.modules.filter((m) => m.name.trim());
  if (!d.modules.length) { toast("Add at least one module"); return; }
  if (!d.studyDays.length) { toast("Pick at least one study day"); return; }
  btn.disabled = true;
  if (S.example) await leaveExample(true);
  await saveProfile(JSON.parse(JSON.stringify(d)));
  for (const id of Object.keys(S.plans)) if (!d.modules.some((m) => m.id === id)) { delete S.plans[id]; await store.remove("plan:" + id); }
  S.draft = null;
  go("today");
  if (!hasKey()) { toast("Saved. Add an AI key in Settings so the tutor can plan your modules."); return; }
  toast("Saved. Planning your modules…");
  for (const m of d.modules) if (!S.plans[m.id]) await buildPlan(m, null);
}

/* ---------- Settings ---------- */
function viewSettings() {
  const s = { provider: "gemini", apiKey: "", model: "", ...(S.settings || {}) };
  const info = PROVIDERS[s.provider];
  const key = h("input", { id: "k-key", type: "password", class: "key", value: s.apiKey, placeholder: info.keyHint, autocomplete: "off", oninput: (e) => { s.apiKey = e.target.value.trim(); } });
  const model = h("input", { id: "k-model", value: s.model, placeholder: info.defaultModel, oninput: (e) => { s.model = e.target.value.trim(); } });
  const save = async (test, btn) => {
    S.settings = { ...s };
    await store.set("settings", S.settings);
    if (!test) { toast("Saved"); render(); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Testing…';
    try { await complete(S.settings, "Reply with the single word: ready", { maxTokens: 20 }); toast("Connected. The tutor is ready."); }
    catch (e) { toast(e.message); }
    render();
  };
  return h("div", { class: "stack", style: "max-width:720px" },
    h("h1", null, "Settings"),
    h("div", { class: "card" }, h("h3", null, "AI provider"),
      h("p", { class: "small muted" }, "The tutor uses an AI model through your own API key. The key is saved only in this browser and is sent only to the provider you choose."),
      h("label", { for: "k-provider" }, "Provider", h("select", { id: "k-provider", onchange: (e) => { S.settings = { ...s, provider: e.target.value, model: "" }; render(); } },
        Object.entries(PROVIDERS).map(([id, p]) => h("option", { value: id, selected: s.provider === id }, p.label)))),
      h("label", { for: "k-key" }, "API key", h("span", { class: "hint" }, "Get one at ", h("a", { href: info.keyUrl, target: "_blank", rel: "noopener" }, info.keyUrl.replace("https://", ""))), key),
      h("label", { for: "k-model" }, "Model", h("span", { class: "hint" }, "Leave blank for the default, " + info.defaultModel), model),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: (e) => save(true, e.target) }, "Save and test"),
        h("button", { class: "btn", onclick: () => save(false) }, "Save"),
        S.settings && S.settings.apiKey ? h("button", { class: "btn ghost", onclick: async () => { S.settings = { ...s, apiKey: "" }; await store.set("settings", S.settings); toast("Key removed"); render(); } }, "Remove key") : null)),
    h("div", { class: "card" }, h("h3", null, "Backup"),
      h("p", { class: "small muted" }, "Your data lives in this browser only. Download a backup to move it to another device or keep it safe. The backup never includes your API key."),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: async () => saveFile(`study-studio-backup-${TODAY}.json`, JSON.stringify(await store.exportAll()), "application/json") }, "Download backup"),
        h("label", { class: "btn", style: "display:inline-flex;cursor:pointer" }, "Restore a backup",
          h("input", { type: "file", accept: ".json", hidden: true, onchange: async (e) => {
            const input = e.target;
            let backup;
            try { backup = JSON.parse(await input.files[0].text()); }
            catch (_) { input.value = ""; toast("That file isn't a valid backup."); return; }
            try { await store.importAll(backup); S.example = false; await load(); toast("Backup restored"); go("today"); }
            catch (err) { toast(err.message || "That file isn't a valid backup."); }
            input.value = ""; // so the same file can be chosen again
          } })))));
}

/* ---------- example course (never saved) ---------- */
function exampleData() {
  const a = { id: "ex-ml", name: "Machine Learning", examDate: addDays(TODAY, 60), priority: "normal" };
  const b = { id: "ex-st", name: "Statistics for Data Science", examDate: addDays(TODAY, 45), priority: "normal" };
  const plan = (m, rows) => ({ moduleId: m.id, topics: rows.map(([title, summary, level], i) => ({ id: `${m.id}-${i}`, title, summary, level, keywords: [] })) });
  return {
    profile: { name: "Alex", programme: "MSc Data Science (example)", level: "Master's", goal: "both", minutesPerDay: 90, studyDays: [1, 2, 3, 4, 5, 6], background: "Good with spreadsheets, new to programming.", modules: [a, b] },
    plans: {
      [a.id]: plan(a, [["What machine learning is", "How a computer learns patterns from examples instead of rules.", 1], ["Training and test data", "Why we hide some data to check a model honestly.", 1], ["Linear regression", "Drawing the best straight line through data.", 2], ["Classification and logistic regression", "Predicting a yes or no answer with probabilities.", 2], ["Decision trees", "Learning a flowchart of questions from data.", 2], ["Overfitting and regularisation", "Why a model that memorises fails on new data.", 3]]),
      [b.id]: plan(b, [["Mean, median and spread", "Summing up a set of numbers in a few figures.", 1], ["Probability basics", "Putting a number on how likely something is.", 1], ["The normal distribution", "The bell curve and why it turns up everywhere.", 2], ["Hypothesis testing", "Deciding whether a result is real or luck.", 3]]),
    },
    progress: { "ex-ml-0": { done: true, doneOn: addDays(TODAY, -1), score: 80, attempts: 1 } },
  };
}
function enterExample() { const ex = exampleData(); Object.assign(S, { example: true, profile: ex.profile, plans: ex.plans, progress: ex.progress, files: {}, bank: {}, draft: null }); go("today"); }
async function leaveExample(keepDraft) {
  let saved;
  try { saved = await store.loadAll(); }
  catch (_) {
    saved = { profile: null, plans: {}, progress: {}, files: {}, bank: {} };
    toast("This browser is blocking storage (private mode?). You can try the app, but nothing will be saved.");
  }
  Object.assign(S, { example: false, profile: saved.profile, plans: saved.plans, progress: saved.progress, files: saved.files, bank: saved.bank });
  if (!keepDraft) { S.draft = null; go("setup"); }
}

/* ---------- start ---------- */
async function load() {
  const saved = await store.loadAll();
  Object.assign(S, saved);
}
addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.some(([id]) => id === v) && v !== S.view) go(v); });
(async () => {
  const v = location.hash.slice(1);
  if (VIEWS.some(([id]) => id === v)) S.view = v;
  try { await load(); }
  catch (_) { toast("This browser blocked saving (private mode?). You can look around, but nothing will be kept."); }
  render();
})();
