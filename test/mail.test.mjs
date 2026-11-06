import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.mjs";
import { signup } from "../src/auth.mjs";
import { classify, matchEmail, decide, detectProvider, cleanBody } from "../src/mail/classify.mjs";
import { applyMail, accountFromInput } from "../src/mail/check.mjs";
import { encrypt, decrypt } from "../src/secrets.mjs";

test("classify: rejection, interview, test, ack, noise", () => {
  assert.equal(classify("", "Thank you for applying. Unfortunately, we have decided to move forward with other candidates."), "rejection");
  assert.equal(classify("", "Purtroppo la tua candidatura non è in linea con il profilo ricercato"), "rejection");
  assert.equal(classify("", "We would like to invite you to a call. Pick a time on calendly.com/x"), "interview");
  assert.equal(classify("", "Prima di procedere completa una breve prova di pre-selezione"), "test");
  assert.equal(classify("", "Abbiamo ricevuto la tua candidatura, ti contatteremo."), "ack");
  assert.equal(classify("Benvenuto, il tuo account è stato creato!", "puoi candidarti, colloquio"), "other");
  assert.equal(classify("Your secure link to sign in", "unfortunately"), "other");
});

test("matchEmail: strong, ambiguous, weak", () => {
  const apps = [{ company: "OralPro", role: "A", status: "Applied" }, { company: "Contrader", role: "B", status: "Applied" }, { company: "Contrader", role: "C", status: "Applied" }, { company: "Mollie", role: "D", status: "Found" }];
  assert.equal(matchEmail({ from: "HR <hr@oralpro.it>", subject: "Re: role", body: "Grazie" }, apps).kind, "strong");
  assert.equal(matchEmail({ from: "no-reply@greenhouse.io", subject: "Your application to Mollie", body: "x" }, apps).app.company, "Mollie");
  assert.equal(matchEmail({ from: "jobs@contrader.it", subject: "Colloquio", body: "ciao" }, apps).kind, "ambiguous");
  assert.equal(matchEmail({ from: "news@random.com", subject: "Offers", body: "see our partner mollie" }, apps).kind, "weak");
});

test("decide never reopens or downgrades", () => {
  assert.equal(decide("rejection", { status: "Applied" }), "Rejected");
  assert.equal(decide("rejection", { status: "Rejected" }), null);
  assert.equal(decide("test", { status: "Interviewing" }), null);
  assert.equal(decide("ack", { status: "Found" }), "Applied");
});

test("providers are detected from the address", () => {
  for (const [u, want] of [["a@icloud.com", "icloud"], ["x@gmail.com", "gmail"], ["x@hotmail.it", "outlook"], ["x@proton.me", "proton"], ["x@mycompany.io", "custom"]]) assert.equal(detectProvider(u), want);
});

test("cleanBody drops links and footers", () => {
  const out = cleanBody({ html: "<p>Hi Ana,</p><p>Unfortunately we will not move forward.</p><p>https://x.test/track?id=1</p><p>You are receiving LinkedIn notification emails.</p>" });
  assert.match(out, /will not move forward/); assert.doesNotMatch(out, /https|receiving/);
});

test("applyMail updates the status, stores the thread once, and resolves several roles at one company", () => {
  const db = openDb(":memory:"), uid = signup(db, "a@example.com", "correct horse battery");
  const add = (company, status) => Number(db.prepare("INSERT INTO applications (user_id, company, role, status, added, updated) VALUES (?, ?, 'PM', ?, 'x', 'x')").run(uid, company, status).lastInsertRowid);
  const a = add("Acme", "Applied"), b = add("Globex", "Applied"), c = add("Globex", "Applied");
  const mail = { from: "Hiring <jobs@acme.com>", subject: "Your application", text: "Unfortunately we will not be moving forward.", html: "", date: new Date("2026-01-05"), messageId: "<1@acme>" };
  const dry = applyMail(db, uid, mail, { dryRun: true });
  assert.equal(dry.change, "Applied -> Rejected"); assert.equal(db.prepare("SELECT status FROM applications WHERE id = ?").get(a).status, "Applied");
  applyMail(db, uid, mail); applyMail(db, uid, mail); // second pass is a no-op on the status, and the thread has one copy
  const row = db.prepare("SELECT status, unread FROM applications WHERE id = ?").get(a);
  assert.equal(row.status, "Rejected"); assert.equal(row.unread, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE application_id = ?").get(a).n, 1);
  const amb = applyMail(db, uid, { from: "x@globex.com", subject: "Colloquio", text: "ciao, colloquio domani", html: "", date: new Date(), messageId: "<2@g>" });
  assert.equal(amb.outcome, "applied", "two Globex roles, the mail names neither: the most recent live one is updated");
  assert.equal(db.prepare("SELECT status FROM applications WHERE id = ?").get(c).status, "Interviewing");
  assert.equal(db.prepare("SELECT status FROM applications WHERE id = ?").get(b).status, "Applied");
  assert.match(db.prepare("SELECT notes FROM applications WHERE id = ?").get(c).notes, /matched by company only/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mail_review WHERE user_id = ?").get(uid).n, 0, "nothing is queued for the user");
});

test("mailbox passwords are encrypted at rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  const blob = encrypt("app-password-123", dir);
  assert.ok(!blob.includes("app-password")); assert.equal(decrypt(blob, dir), "app-password-123");
  assert.throws(() => decrypt(blob.slice(0, -4) + "AAAA", dir));
  const acc = accountFromInput({ user: "me@gmail.com", password: "pw", folders: "INBOX, Jobs" }, s => encrypt(s, dir));
  assert.equal(acc.host, "imap.gmail.com"); assert.deepEqual(acc.folders, ["INBOX", "Jobs"]);
  assert.throws(() => accountFromInput({ user: "nope" }, s => s), /full email/);
});

test("LinkedIn 'application was sent' confirms the application; non-replies from known companies are not queued for review", () => {
  const db = openDb(":memory:"), uid = signup(db, "b@example.com", "correct horse battery");
  const add = (company, role, status) => Number(db.prepare("INSERT INTO applications (user_id, company, role, status, added, updated) VALUES (?, ?, ?, ?, 'x', 'x')").run(uid, company, role, status).lastInsertRowid);
  const pm = add("Acme", "Product Manager Intern", "Found"), qa = add("Acme", "QA Engineer", "Found");
  const sent = { from: '"LinkedIn" <jobs-noreply@linkedin.com>', subject: "Ahmed, your application was sent to Acme", text: "Your application was sent. Product Manager Intern at Acme, Milan", html: "", date: new Date("2026-02-01"), messageId: "<s1>" };
  const r = applyMail(db, uid, sent);
  assert.equal(r.outcome, "applied"); assert.equal(db.prepare("SELECT status FROM applications WHERE id = ?").get(pm).status, "Applied");
  assert.equal(db.prepare("SELECT status FROM applications WHERE id = ?").get(qa).status, "Found", "the other Acme role is untouched");
  const noise = applyMail(db, uid, { from: "LinkedIn <messages-noreply@linkedin.com>", subject: "See hiring trends for Acme", text: "Acme is growing", html: "", date: new Date(), messageId: "<n1>" });
  assert.equal(noise.outcome, "ignored");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mail_review").get().n, 0);
});
