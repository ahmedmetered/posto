// Bring applications from another tracker into Posto.
// Run: node scripts/import-applications.mjs <file.json|file.csv> <your Posto email> [--db data/app.db] [--dry]
//
// JSON: an array, or { "apps": [...] }. CSV: a header row, comma separated, quoted fields allowed.
// Recognised columns (anything else is ignored): company, role (or title), url, status, cv, notes, salary,
// location, source, date (or date_applied), added, updated, top, easy.
// Statuses that Posto does not know become "Found". Rows already in Posto (same link, or same company and role) are skipped.
import fs from "node:fs";
import { openDb, now } from "../src/db.mjs";

const STATUSES = ["Found", "Ready to send", "Applied", "Replied", "Interviewing", "Offer", "Rejected", "Withdrawn"];
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x !== "")) rows.push(row);
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const truthy = v => v === true || /^(1|true|yes|y)$/i.test(String(v ?? ""));
const day = v => { const d = new Date(v); return v && !isNaN(d) ? d.toISOString().slice(0, 10) : ""; };
const cap = (v, n) => String(v ?? "").slice(0, n);

export function normalizeRow(r) {
  const status = STATUSES.find(s => s.toLowerCase() === String(r.status || "").trim().toLowerCase()) || "Found";
  const url = /^https?:\/\//i.test(r.url || "") ? cap(r.url, 600) : "";
  const parts = [r.notes, r.next && `Next: ${r.next}`, r.source && `Source: ${r.source}`].filter(Boolean).join(" | ");
  return { company: cap(r.company, 120).trim(), role: cap(r.role || r.title, 160).trim(), url, status, cv: cap(r.cv, 80), notes: cap(parts, 4000), salary: cap(r.salary, 80), location: cap(r.location, 120),
    top: truthy(r.top) ? 1 : 0, easy: truthy(r.easy) ? 1 : 0, date_applied: status === "Found" || status === "Ready to send" ? "" : day(r.date || r.date_applied || r.updated), added: day(r.added) || day(r.updated) || new Date().toISOString().slice(0, 10), updated: day(r.updated) || day(r.added) || new Date().toISOString().slice(0, 10) };
}

export function importApplications(db, userId, rows, { dry = false } = {}) {
  const have = db.prepare("SELECT url, lower(company) c, lower(role) r FROM applications WHERE user_id = ?").all(userId);
  const urls = new Set(have.map(h => h.url).filter(Boolean)), keys = new Set(have.map(h => h.c + "|" + h.r));
  const ins = db.prepare(`INSERT INTO applications (user_id, company, role, url, status, cv, notes, salary, location, top, easy, date_applied, added, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const out = { added: 0, skipped: 0, invalid: 0, byStatus: {} };
  db.exec("BEGIN");
  try {
    for (const raw of rows) {
      const a = normalizeRow(raw);
      if (!a.company || !a.role) { out.invalid++; continue; }
      const key = a.company.toLowerCase() + "|" + a.role.toLowerCase();
      if ((a.url && urls.has(a.url)) || keys.has(key)) { out.skipped++; continue; }
      if (!dry) ins.run(userId, a.company, a.role, a.url, a.status, a.cv, a.notes, a.salary, a.location, a.top, a.easy, a.date_applied, a.added, a.updated);
      if (a.url) urls.add(a.url); keys.add(key); out.added++; out.byStatus[a.status] = (out.byStatus[a.status] || 0) + 1;
    }
    db.exec(dry ? "ROLLBACK" : "COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const argv = process.argv.slice(2), flag = n => argv.includes(n), opt = n => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const [file, email] = argv.filter(a => !a.startsWith("--") && a !== opt("--db"));
  if (!file || !email) { console.log("Usage: node scripts/import-applications.mjs <file.json|file.csv> <your Posto email> [--db data/app.db] [--dry]"); process.exit(1); }
  const db = openDb(opt("--db") || "data/app.db"), user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) { console.log(`No Posto account for ${email}. Sign up in the app first, then run this again.`); process.exit(1); }
  const text = fs.readFileSync(file, "utf8");
  let rows = /\.csv$/i.test(file) ? parseCsv(text) : JSON.parse(text);
  if (!Array.isArray(rows)) rows = rows.apps || rows.applications || [];
  const r = importApplications(db, user.id, rows, { dry: flag("--dry") });
  console.log(`${flag("--dry") ? "Would add" : "Added"} ${r.added}, skipped ${r.skipped} already in Posto, ${r.invalid} without company or role.`);
  console.log(Object.entries(r.byStatus).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
}
