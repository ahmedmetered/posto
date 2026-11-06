// Why does a profile get so few matches? Counts what blocks the jobs whose title DOES match a role type.
// Run: node scripts/explain.mjs [path/to/app.db] [user email]
import { openDb } from "../src/db.mjs";
import { evaluate } from "../src/eligibility.mjs";
import { normalizeProfile } from "../src/profile.mjs";

const db = openDb(process.argv[2] || "data/app.db"), email = process.argv[3];
const row = email ? db.prepare("SELECT p.json FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.email = ?").get(email) : db.prepare("SELECT json FROM profiles").get();
if (!row) { console.log("No profile found."); process.exit(1); }
const profile = normalizeProfile(JSON.parse(row.json));
const tally = {}; let onTrack = 0, total = 0;
for (const r of db.prepare("SELECT * FROM jobs").all()) {
  total++;
  const res = evaluate({ title: r.title, company: r.company, location: r.location, remote: r.remote == null ? null : !!r.remote, employment: r.employment || undefined, description: r.description,
    salary: r.salary_json ? JSON.parse(r.salary_json) : null, sponsorship: r.sponsorship == null ? null : !!r.sponsorship, posted_at: r.posted_at }, profile);
  if (res.reasons.some(x => x.code === "off_track")) continue;
  onTrack++;
  const blocks = res.reasons.filter(x => x.kind === "block").map(x => x.code);
  for (const b of blocks.length ? blocks : [res.verdict]) tally[b] = (tally[b] || 0) + 1;
}
console.log(`${total} postings stored, ${onTrack} have a title that matches one of your role types.`);
console.log("What happens to those (a job can have several reasons):");
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
