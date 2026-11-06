// The daily sweep: pull jobs from the sources into the shared table, then match them to every user's profile.
// Run: node src/sweep.mjs [--no-fetch]   (--no-fetch only re-matches what is already stored)
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { openDb, now } from "./db.mjs";
import { evaluate } from "./eligibility.mjs";
import { normalizeProfile } from "./profile.mjs";
import { ADAPTERS, FEEDS, fetchHimalayas, fetchRemotive } from "./sources/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_AGE_DAYS = 45;

export function ingest(db, jobs) {
  const t = now(); let added = 0;
  const find = db.prepare("SELECT id FROM jobs WHERE source = ? AND ext_id = ?");
  const ins = db.prepare(`INSERT INTO jobs (source, ext_id, company, title, location, remote, employment, description, url, salary_json, sponsorship, languages_json, posted_at, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare("UPDATE jobs SET last_seen = ?, title = ?, location = ?, description = ?, url = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const j of jobs) {
      if (!j || !j.title || !j.url || !j.ext_id) continue;
      const ex = find.get(j.source, String(j.ext_id));
      if (ex) { upd.run(t, j.title, j.location || "", j.description || "", j.url, ex.id); continue; }
      ins.run(j.source, String(j.ext_id), j.company || "", j.title, j.location || "", j.remote == null ? null : j.remote ? 1 : 0, j.employment || null, j.description || "", j.url,
        j.salary ? JSON.stringify(j.salary) : null, j.sponsorship == null ? null : j.sponsorship ? 1 : 0, j.languages_required ? JSON.stringify(j.languages_required) : null, j.posted_at || null, t, t);
      added++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return added;
}

const rowToJob = r => ({ title: r.title, company: r.company, location: r.location, remote: r.remote == null ? null : !!r.remote, employment: r.employment || undefined, description: r.description,
  salary: r.salary_json ? JSON.parse(r.salary_json) : null, sponsorship: r.sponsorship == null ? null : !!r.sponsorship, languages_required: r.languages_json ? JSON.parse(r.languages_json) : undefined, posted_at: r.posted_at });

// match every recent job against one user's profile; keep fit/check rows, never touch jobs the user already acted on
export function matchUser(db, userId) {
  const p = db.prepare("SELECT json FROM profiles WHERE user_id = ?").get(userId);
  if (!p) return { evaluated: 0, fit: 0, check: 0, no: 0 };
  const profile = normalizeProfile(JSON.parse(p.json));
  const since = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString();
  const jobs = db.prepare("SELECT * FROM jobs WHERE COALESCE(posted_at, first_seen) >= ?").all(since);
  const keep = db.prepare("SELECT job_id, state FROM user_jobs WHERE user_id = ?").all(userId);
  const acted = new Set(keep.filter(k => k.state !== "new").map(k => k.job_id));
  const up = db.prepare(`INSERT INTO user_jobs (user_id, job_id, verdict, score, reasons_json, track, cv, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)
    ON CONFLICT(user_id, job_id) DO UPDATE SET verdict = excluded.verdict, score = excluded.score, reasons_json = excluded.reasons_json, track = excluded.track, cv = excluded.cv WHERE user_jobs.state = 'new'`);
  const del = db.prepare("DELETE FROM user_jobs WHERE user_id = ? AND job_id = ? AND state = 'new'");
  const stats = { evaluated: 0, fit: 0, check: 0, no: 0 }, t = now(), blockedBy = {};
  let onTrack = 0;
  db.exec("BEGIN");
  try {
    for (const r of jobs) {
      if (acted.has(r.id)) continue;
      const res = evaluate(rowToJob(r), profile); stats.evaluated++; stats[res.verdict]++;
      if (!res.reasons.some(x => x.code === "off_track")) { onTrack++; for (const x of res.reasons) if (x.kind === "block") blockedBy[x.code] = (blockedBy[x.code] || 0) + 1; }
      if (res.verdict === "no") del.run(userId, r.id);
      else up.run(userId, r.id, res.verdict, res.score, JSON.stringify(res.reasons), res.track?.name || null, res.track?.cv || null, t);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  // kept so the app can say WHY nothing matched, not just that nothing did
  db.prepare("INSERT INTO settings (user_id, k, v) VALUES (?, 'match_stats', ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v").run(userId, JSON.stringify({ at: t, onTrack, blockedBy }));
  return stats;
}

function queriesFor(db) {
  const words = new Set();
  for (const r of db.prepare("SELECT json FROM profiles").all()) for (const t of normalizeProfile(JSON.parse(r.json)).tracks) for (const k of t.keywords.slice(0, 4)) words.add(k);
  return [...words].slice(0, 12);
}

const FEED_NAMES = ["himalayas", "remotive", "remoteok", "wwr", "arbeitnow", "jobicy"];
export const feedNames = () => FEED_NAMES;

export function seedBoards(db) {
  if (db.prepare("SELECT COUNT(*) n FROM boards").get().n) return;
  const ins = db.prepare("INSERT OR IGNORE INTO boards (ats, slug) VALUES (?, ?)");
  for (const { co, ats } of JSON.parse(fs.readFileSync(path.join(here, "boards.json"), "utf8"))) ins.run(ats, co);
}
export const disabledFeeds = db => { const r = db.prepare("SELECT v FROM kv WHERE k = 'feeds_off'").get(); try { return r ? JSON.parse(r.v) : []; } catch { return []; } };

// run async jobs a few at a time
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export async function fetchAll(db, log = console.log) {
  seedBoards(db);
  const off = new Set(disabledFeeds(db)), counts = {}, errors = {};
  let all = [];
  const take = (name, jobs) => { counts[name] = (counts[name] || 0) + jobs.length; all = all.concat(jobs); };
  const fail = (name, e) => { errors[name] = e.message; log(`  ${name}: ${e.message}`); };
  const boards = db.prepare("SELECT ats, slug FROM boards WHERE enabled = 1").all().filter(b => ADAPTERS[b.ats]);
  await pool(boards, 5, async b => { try { take(b.ats, await ADAPTERS[b.ats](b.slug)); } catch (e) { fail(`${b.ats}/${b.slug}`, e); } });
  const q = queriesFor(db);
  if (q.length && !off.has("himalayas")) { try { take("himalayas", await fetchHimalayas(q)); } catch (e) { fail("himalayas", e); } }
  if (q.length && !off.has("remotive")) for (const w of q.slice(0, 5)) { try { take("remotive", await fetchRemotive(w)); } catch (e) { fail("remotive", e); break; } }
  await pool(Object.entries(FEEDS).filter(([n]) => !off.has(n)), 4, async ([n, f]) => { try { take(n, await f()); } catch (e) { fail(n, e); } });
  return { jobs: all, counts, errors };
}

export async function runSweep(db, { fetch = true, log = console.log } = {}) {
  let added = 0, counts = {}, errors = {};
  if (fetch) {
    const r = await fetchAll(db, log); counts = r.counts; errors = r.errors;
    added = ingest(db, r.jobs); log(`fetched ${r.jobs.length} postings, ${added} new`);
  }
  const per = [];
  for (const u of db.prepare("SELECT id, email FROM users").all()) { const s = matchUser(db, u.id); per.push({ user: u.email, ...s }); log(`  user ${u.id}: ${s.fit} fit, ${s.check} to check, ${s.no} blocked of ${s.evaluated}`); }
  const summary = { at: now(), fetched: fetch, added, counts, errors };
  db.prepare("INSERT INTO kv (k, v) VALUES ('last_sweep', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(summary));
  return { added, per, counts, errors };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = openDb();
  runSweep(db, { fetch: !process.argv.includes("--no-fetch") }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
