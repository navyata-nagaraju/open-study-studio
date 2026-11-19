// planner.js — turns topics, exam dates and study days into a daily plan.
//
// Key design choice: the plan is never stored. It is worked out again from
// today every time the page opens. So if a student misses a day, nothing
// "piles up" as overdue; the unfinished topics simply move to the next
// study days. All functions are pure, so they can be tested in Node.

export const MINUTES_PER_TOPIC = 45;

// Date helpers. Dates are plain "YYYY-MM-DD" strings, which sort correctly as text.
export function isoDate(d) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}
export function addDays(date, n) {
  const x = new Date(date + "T12:00:00");
  x.setDate(x.getDate() + n);
  return isoDate(x);
}

export function isStudyDay(profile, date) {
  const weekday = new Date(date + "T12:00:00").getDay(); // 0 = Sunday
  const days = profile.studyDays || [1, 2, 3, 4, 5, 6];
  return days.includes(weekday) && !(profile.offDates || []).includes(date);
}

export const topicsPerDay = (profile) => Math.max(1, Math.round((Number(profile.minutesPerDay) || 60) / MINUTES_PER_TOPIC));

// How pressed a module is: topics left divided by study days left before its exam.
// Modules with no exam date get an 8-week horizon.
export function urgency(profile, module, topicsLeft, from) {
  const end = module.examDate && module.examDate > from ? module.examDate : addDays(from, 56);
  let days = 0;
  for (let d = from; d < end && days < 400; d = addDays(d, 1)) if (isStudyDay(profile, d)) days++;
  return topicsLeft / Math.max(1, days) + (module.priority === "high" ? 0.3 : 0);
}

// Builds the next `days` days of work. Each study day gets:
//   1) topics already finished today (shown ticked),
//   2) reviews that are due (topics scored under 70% come back after 3 days),
//   3) new topics, always from the most pressed module first.
export function schedule({ profile, plans, progress, today, days = 7 }) {
  const modules = profile.modules || [];
  const topicsOf = (id) => (plans[id] && plans[id].topics) || [];
  const p = (id) => progress[id] || {};

  const queue = {};
  const reviews = [];
  for (const m of modules) {
    queue[m.id] = topicsOf(m.id).filter((t) => !p(t.id).done).map((t) => ({ t, m }));
    for (const t of topicsOf(m.id)) {
      const pr = p(t.id);
      if (pr.done && pr.reviewOn && pr.doneOn !== today) reviews.push({ t, m, on: pr.reviewOn < today ? today : pr.reviewOn });
    }
  }
  reviews.sort((a, b) => a.on.localeCompare(b.on));
  const doneToday = Object.keys(progress).filter((id) => progress[id].doneOn === today);

  const out = {};
  for (let i = 0, d = today; i < days; i++, d = addDays(d, 1)) {
    out[d] = [];
    if (!isStudyDay(profile, d)) continue;
    let slots = topicsPerDay(profile);

    if (d === today) {
      for (const id of doneToday) {
        const m = modules.find((mm) => topicsOf(mm.id).some((t) => t.id === id));
        const t = m && topicsOf(m.id).find((tt) => tt.id === id);
        if (t) { out[d].push({ t, m, done: true }); slots--; }
      }
    }
    while (slots > 0 && reviews.length && reviews[0].on <= d) {
      const r = reviews.shift();
      out[d].push({ t: r.t, m: r.m, review: true });
      slots--;
    }
    while (slots > 0) {
      const candidates = modules.filter((m) => queue[m.id].length);
      if (!candidates.length) break;
      candidates.sort((a, b) => urgency(profile, b, queue[b.id].length, d) - urgency(profile, a, queue[a.id].length, d));
      const next = queue[candidates[0].id].shift();
      out[d].push({ t: next.t, m: next.m });
      slots--;
    }
  }
  return out;
}

export function moduleStats(plans, progress, moduleId) {
  const topics = (plans[moduleId] && plans[moduleId].topics) || [];
  const done = topics.filter((t) => progress[t.id] && progress[t.id].done).length;
  const scores = topics.map((t) => progress[t.id] && progress[t.id].score).filter((x) => x != null);
  return { total: topics.length, done, avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null };
}

// Practice difficulty from 1 to 5. Starts from the topic's last score, or the
// module average, or 40% for a brand-new student, and goes up one more level
// on a second attempt.
export function difficulty(plans, progress, moduleId, topicId) {
  const own = progress[topicId] && progress[topicId].score;
  const score = own ?? moduleStats(plans, progress, moduleId).avg ?? 40;
  const retry = progress[topicId] && progress[topicId].attempts > 1 ? 1 : 0;
  return Math.min(5, Math.max(1, 1 + Math.floor(score / 22) + retry));
}

// Records a finished practice round. Under 70% schedules a review in 3 days.
export function recordScore(progress, topicId, score, today) {
  const prev = progress[topicId] || {};
  return {
    ...progress,
    [topicId]: {
      done: true,
      doneOn: today,
      score,
      attempts: (prev.attempts || 0) + 1,
      reviewOn: score < 70 ? addDays(today, 3) : null,
      history: [...(prev.history || []), { d: today, s: score }].slice(-10),
    },
  };
}
