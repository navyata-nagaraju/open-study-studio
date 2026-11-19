// store.js — saves everything in the browser with IndexedDB.
// IndexedDB is a small database built into every modern browser. It can hold
// far more than localStorage (whole lecture PDFs), and the data never leaves
// the user's device.
//
// Everything is stored as key -> value pairs in one table ("kv"):
//   "settings"        AI provider, API key and model
//   "profile"         course, modules, study days
//   "progress"        score and status for every topic
//   "file:<id>"       one uploaded document, split into chunks
//   "plan:<moduleId>" the topic list for a module
//   "bank:<moduleId>" every practice question answered for a module

const DB_NAME = "open-study-studio";
const TABLE = "kv";
let opening = null;

function openDb() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(TABLE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

// Wraps one IndexedDB request in a Promise so the rest of the app can use await.
async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, mode);
    const req = action(tx.objectStore(TABLE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const get = (key) => run("readonly", (t) => t.get(key));
export const set = (key, value) => run("readwrite", (t) => t.put(value, key));
export const remove = (key) => run("readwrite", (t) => t.delete(key));
export const keys = () => run("readonly", (t) => t.getAllKeys());

// Reads every saved record and sorts it into the shape the app uses.
export async function loadAll() {
  const state = { settings: null, profile: null, progress: {}, files: {}, plans: {}, bank: {} };
  for (const key of await keys()) {
    const value = await get(key);
    if (key === "settings") state.settings = value;
    else if (key === "profile") state.profile = value;
    else if (key === "progress") state.progress = value || {};
    else if (key.startsWith("file:")) state.files[key.slice(5)] = value;
    else if (key.startsWith("plan:")) state.plans[key.slice(5)] = value;
    else if (key.startsWith("bank:")) state.bank[key.slice(5)] = value;
  }
  return state;
}

// Backup: every record except the API key, as one JSON object.
export async function exportAll() {
  const out = {};
  for (const key of await keys()) if (key !== "settings") out[key] = await get(key);
  return { app: "open-study-studio", version: 1, exportedOn: new Date().toISOString(), data: out };
}

export async function importAll(backup) {
  if (!backup || backup.app !== "open-study-studio" || typeof backup.data !== "object") {
    throw new Error("This file isn't an Open Study Studio backup.");
  }
  for (const [key, value] of Object.entries(backup.data)) await set(key, value);
}
