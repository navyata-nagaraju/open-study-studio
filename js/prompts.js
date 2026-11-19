// prompts.js — every instruction the app sends to the AI model, in one place.
// Keeping prompts together makes them easy to read, compare and improve.

const goalText = (goal) => (goal === "interviews" ? "job interviews" : goal === "both" ? "exams and job interviews" : "exams");

export const TEACHING_STYLE = `Explain like you are teaching a bright 5-year-old who has no background in this subject: start with an everyday picture or story, then a tiny concrete example with real numbers, code or a worked case, and only then give the proper technical name. Short sentences, one idea at a time, never an unexplained word. Warm and encouraging. British English. Markdown with short headings, code in fenced blocks.`;

export function planPrompt(profile, module, material) {
  return `You are planning a course of study for a student.
Student: ${profile.level || "university"} student on "${profile.programme || "their course"}". Background: ${profile.background || "not given; assume a beginner"}. Goal: ${goalText(profile.goal)}.
Module: "${module.name}".${material ? `
Extracts from the student's own materials for this module:
${material}` : "\nNo materials uploaded. Use the standard syllabus for a module with this name at this level."}

Break the module into 8 to 18 study topics that each take about 45 minutes. Order them from the absolute basics to the most advanced, so each topic only needs the ones before it. Base the topics on the materials when they are given.
Return JSON: {"topics":[{"title":"short topic name","summary":"one sentence on what the student will understand","level":1,"keywords":["3 to 6 search words found in the materials"]}]} where level is 1 (foundation), 2 (core) or 3 (advanced).`;
}

export function lessonPrompt(profile, module, topic, extracts) {
  return `${TEACHING_STYLE}
Teach the topic "${topic.title}" from the module "${module.name}" (${["", "foundation", "core", "advanced"][topic.level]} level). Aim: ${topic.summary}
Student: ${profile.level || "university"} student, background: ${profile.background || "beginner"}.${extracts.length ? `
Base the lesson on these extracts from the student's own course materials. Use their notation and examples where you can:
${extracts.map((x) => `[${x.file}]\n${x.text}`).join("\n---\n")}` : ""}
Structure: 1) The everyday picture. 2) What it really is. 3) A worked example. 4) Common mistakes. 5) A three-line summary. Keep it under 700 words. Do not include quiz questions.`;
}

export function checkPrompt(module, topic, lesson) {
  return `Write 3 multiple-choice questions that check basic understanding of "${topic.title}" (${module.name}), matching this lesson:
${String(lesson || topic.summary).slice(0, 4000)}
Return JSON: {"questions":[{"q":"...","options":["...","...","...","..."],"answer":0,"why":"one sentence"}]} where answer is the index of the correct option.`;
}

export function practicePrompt(profile, module, topic, level, extracts) {
  const style = profile.goal === "interviews" ? "job interview questions" : profile.goal === "both" ? "a mix of exam and job interview questions" : "university exam questions";
  return `Write 3 practice questions on "${topic.title}" from the module "${module.name}" at difficulty ${level} of 5 (1 = recall a definition, 3 = apply it to a new case, 5 = a hard question that combines ideas or asks for trade-offs). Style: ${style}. Each must be answerable in a few sentences, a short calculation or a few lines of code.${extracts.length ? "\nUse the student's materials for notation:\n" + extracts.map((x) => x.text).join("\n---\n").slice(0, 3500) : ""}
Return JSON: {"questions":[{"q":"...","model":"a full model answer","marks":"what earns full marks, in one line"}]}`;
}

export function markPrompt(questions, answers) {
  return `Mark a student's answers fairly but strictly, like an examiner. For each answer give a score from 0 to 10 and two sentences of feedback: what was right and the one thing to add or fix. A blank answer scores 0.
${questions.map((q, i) => `Question ${i + 1}: ${q.q}\nModel answer: ${q.model}\nFull marks: ${q.marks}\nStudent answer: ${answers[i] || "(blank)"}`).join("\n\n")}
Return JSON: {"marks":[{"score":7,"feedback":"..."}]}`;
}
