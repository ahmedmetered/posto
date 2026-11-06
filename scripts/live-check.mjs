import { openDb } from "../src/db.mjs";
import { signup } from "../src/auth.mjs";
import { runSweep } from "../src/sweep.mjs";
import { normalizeProfile } from "../src/profile.mjs";
const db = openDb("data/live-test.db");
let id = db.prepare("SELECT id FROM users WHERE email = ?").get("me@example.com")?.id;
if (!id) id = signup(db, "me@example.com", "a long test password");
const profile = normalizeProfile({ home_country: "IT", home_city: "Milan", max_hours_week: null, languages: ["en", "it"], seniority_max: "mid",
  tracks: [{ name: "Product", keywords: ["product manager", "product owner", "product builder", "apm"], cv: "Product EN PDF" }, { name: "Data", keywords: ["data analyst", "analytics"], cv: "Data CV" }, { name: "QA", keywords: ["test automation", "qa engineer", "quality assurance"], cv: "QA CV" }] });
db.prepare("INSERT INTO profiles (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json").run(id, JSON.stringify(profile), new Date().toISOString());
const t = Date.now();
await runSweep(db);
console.log("took", Math.round((Date.now() - t) / 1000), "s;", db.prepare("SELECT COUNT(*) n FROM jobs").get().n, "jobs stored");
for (const r of db.prepare("SELECT uj.verdict, uj.score, j.company, j.title, j.location, uj.reasons_json FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id WHERE uj.user_id = ? ORDER BY (uj.verdict='fit') DESC, uj.score DESC LIMIT 14").all(id))
  console.log(r.verdict.padEnd(5), String(r.score).padStart(3), r.company.slice(0, 16).padEnd(16), r.title.slice(0, 44).padEnd(44), r.location.slice(0, 26).padEnd(26), JSON.parse(r.reasons_json).filter(x => x.kind !== "plus").map(x => x.code).join(","));
process.exit(0);
