import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { signup } from "../src/auth.mjs";
const { parseCsv, importApplications, normalizeRow } = await import("../scripts/import-applications.mjs").catch(() => ({}));

test("CSV parser handles quotes, commas and newlines inside fields", () => {
  const rows = parseCsv('company,role,notes\nAcme,"PM, Growth","said ""hi""\nsecond line"\nGlobex,QA,\n');
  assert.equal(rows.length, 2); assert.equal(rows[0].role, "PM, Growth"); assert.equal(rows[0].notes, 'said "hi"\nsecond line');
});

test("rows are normalised, deduplicated, and unknown statuses become Found", () => {
  const db = openDb(":memory:"), uid = signup(db, "a@example.com", "correct horse battery");
  const rows = [
    { company: "Acme", role: "PM", url: "https://x/1", status: "applied", date: "2026-10-01", easy: true, next: "call Monday", source: "LinkedIn", cv: "Product EN" },
    { company: "Acme", role: "PM", url: "https://x/1", status: "Applied" },
    { company: "Globex", title: "QA", status: "Maybe", url: "javascript:alert(1)" },
    { company: "", role: "nobody" },
  ];
  const dry = importApplications(db, uid, rows, { dry: true }); assert.equal(dry.added, 2); assert.equal(db.prepare("SELECT COUNT(*) n FROM applications").get().n, 0);
  const r = importApplications(db, uid, rows); assert.deepEqual([r.added, r.skipped, r.invalid], [2, 1, 1]);
  const a = db.prepare("SELECT * FROM applications WHERE company = 'Acme'").get();
  assert.equal(a.status, "Applied"); assert.equal(a.date_applied, "2026-10-01"); assert.equal(a.easy, 1); assert.match(a.notes, /Next: call Monday \| Source: LinkedIn/);
  const g = db.prepare("SELECT * FROM applications WHERE company = 'Globex'").get(); assert.equal(g.status, "Found"); assert.equal(g.url, "");
  assert.equal(importApplications(db, uid, rows).added, 0, "running it twice adds nothing");
  assert.equal(normalizeRow({ company: "A", role: "B", status: "Found", date: "2026-01-01" }).date_applied, "");
});
