// Run with: npm test   (needs Node 18 or newer, no installs required)
import { test } from "node:test";
import assert from "node:assert/strict";
import { schedule, addDays, isStudyDay, difficulty, recordScore, topicsPerDay } from "../js/planner.js";

const profile = (extra = {}) => ({
  minutesPerDay: 90, // 2 topics a day
  studyDays: [1, 2, 3, 4, 5, 6], // Monday to Saturday
  modules: [
    { id: "a", name: "Soon exam", examDate: "2027-01-10" },
    { id: "b", name: "Later exam", examDate: "2027-05-01" },
  ],
  ...extra,
});
const plans = {
  a: { topics: Array.from({ length: 6 }, (_, i) => ({ id: "a" + i, title: "A" + i })) },
  b: { topics: Array.from({ length: 6 }, (_, i) => ({ id: "b" + i, title: "B" + i })) },
};
const MONDAY = "2026-11-23";

test("addDays crosses month ends", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("Sundays and busy days are not study days", () => {
  assert.equal(isStudyDay(profile(), "2026-11-22"), false); // Sunday
  assert.equal(isStudyDay(profile(), MONDAY), true);
  assert.equal(isStudyDay(profile({ offDates: [MONDAY] }), MONDAY), false);
});

test("each study day gets minutesPerDay / 45 topics", () => {
  assert.equal(topicsPerDay(profile()), 2);
  const out = schedule({ profile: profile(), plans, progress: {}, today: MONDAY, days: 3 });
  for (const day of Object.values(out)) assert.equal(day.length, 2);
});

test("the module with the nearer exam is scheduled first", () => {
  const out = schedule({ profile: profile(), plans, progress: {}, today: MONDAY, days: 1 });
  assert.equal(out[MONDAY][0].m.id, "a");
});

test("topics stay in order within a module", () => {
  const out = schedule({ profile: profile(), plans, progress: {}, today: MONDAY, days: 5 });
  const order = Object.values(out).flat().filter((x) => x.m.id === "a").map((x) => x.t.id);
  assert.deepEqual(order, [...order].sort());
});

test("a missed day doesn't pile up: unfinished topics just move forward", () => {
  const tuesday = addDays(MONDAY, 1);
  const out = schedule({ profile: profile(), plans, progress: {}, today: tuesday, days: 1 });
  assert.equal(out[tuesday].length, 2); // still 2, not 4
});

test("a low score brings the topic back for review after 3 days", () => {
  const progress = recordScore({}, "a0", 50, MONDAY);
  assert.equal(progress.a0.reviewOn, addDays(MONDAY, 3));
  const out = schedule({ profile: profile(), plans, progress, today: addDays(MONDAY, 3), days: 1 });
  assert.ok(out[addDays(MONDAY, 3)].some((x) => x.t.id === "a0" && x.review));
});

test("a good score needs no review", () => {
  assert.equal(recordScore({}, "a0", 80, MONDAY).a0.reviewOn, null);
});

test("difficulty rises with scores and stays between 1 and 5", () => {
  assert.equal(difficulty(plans, {}, "a", "a0"), 2); // new student starts at 40%
  assert.equal(difficulty(plans, { a0: { score: 95, attempts: 3 } }, "a", "a0"), 5);
  assert.equal(difficulty(plans, { a0: { score: 0, attempts: 1 } }, "a", "a0"), 1);
});

test("a low score shows its review in the week plan on the same day it was scored", () => {
  const progress = recordScore({}, "a0", 50, MONDAY);
  const out = schedule({ profile: profile(), plans, progress, today: MONDAY, days: 4 });
  assert.ok(out[addDays(MONDAY, 3)].some((x) => x.t.id === "a0" && x.review));
});
