import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jobapp-"));
const { openDb } = await import("../src/db.mjs");
const { createApp } = await import("../src/server.mjs");
const { ingest } = await import("../src/sweep.mjs");
const { buildDigest, sendWebhook } = await import("../src/digest.mjs");
const { sweepAndNotify, getSchedule, setSchedule } = await import("../src/scheduler.mjs");
const S = await import("../src/sources/index.mjs");

function boot(aiFetch) {
  const db = openDb(":memory:"), server = http.createServer(createApp(db, { aiFetch }));
  return new Promise(r => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`; let sid = "";
    const call = async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(sid ? { cookie: `sid=${sid}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get("set-cookie"); if (sc) { const m = sc.match(/sid=([^;]*)/); sid = m ? m[1] : ""; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
    r({ db, call, close: () => server.close() });
  }));
}
const CV = "Product manager with five years running discovery, user research, roadmap planning and analytics for B2B software. Wrote PRDs, shipped experiments, SQL daily, Jira, stakeholder management.";
const PM = { home_country: "IT", tracks: [{ name: "Product", keywords: ["product manager"], cv: "Product EN" }], seniority_max: "senior" };
const NOW = () => new Date().toISOString();
const ACME = { source: "t", ext_id: "1", company: "Acme", title: "Product Manager", location: "Remote - Worldwide", remote: true, url: "https://x/1", employment: "full_time", description: "Own the roadmap, run user research and discovery, write PRDs, use SQL.", posted_at: NOW() };

test("CVs: save, rank against a job, tailor with a stubbed model, reject bad input", async () => {
  let prompt = "";
  const s = await boot(async (url, o) => { prompt = JSON.parse(o.body).messages?.at(-1)?.content || ""; return { ok: true, json: async () => ({ choices: [{ message: { content: "Tailored summary" } }] }) }; });
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    await s.call("PUT", "/api/profile", PM);
    ingest(s.db, [ACME]);
    await s.call("POST", "/api/rematch");
    const feed = (await s.call("GET", "/api/feed")).json; const id = feed.jobs[0].id;

    assert.equal((await s.call("PUT", "/api/cvs", { name: "", text: CV })).status, 400);
    assert.equal((await s.call("PUT", "/api/cvs", { name: "Product EN", text: "short" })).status, 400);
    assert.equal((await s.call("PUT", "/api/cvs", { name: "Product EN", text: CV })).status, 200);
    assert.equal((await s.call("PUT", "/api/cvs", { name: "QA", text: "QA engineer. Test automation with Playwright and Selenium, regression suites, CI pipelines, API testing." })).status, 200);
    const list = (await s.call("GET", "/api/cvs")).json.cvs; assert.equal(list.length, 2);
    const fit = (await s.call("GET", `/api/feed/${id}/cv-fit`)).json; assert.equal(fit.ranked[0].name, "Product EN"); assert.ok(fit.ranked[0].coverage > fit.ranked[1].coverage);
    assert.equal((await s.call("GET", `/api/feed/${id}`)).json.title, "Product Manager");

    assert.equal((await s.call("POST", `/api/feed/${id}/tailor`, { cv: "Product EN", kind: "summary" })).status, 400, "no AI configured yet");
    assert.equal((await s.call("PUT", "/api/settings", { ai: { provider: "ollama" } })).status, 200);
    const t = await s.call("POST", `/api/feed/${id}/tailor`, { cv: "Product EN", kind: "summary" });
    assert.equal(t.json.text, "Tailored summary"); assert.match(prompt, /Product Manager at Acme/); assert.match(prompt, /discovery/);
    assert.equal((await s.call("POST", `/api/feed/${id}/tailor`, { cv: "Nope", kind: "summary" })).status, 400);
    assert.equal((await s.call("DELETE", `/api/cvs/${list[0].id}`)).status, 200);
    assert.equal((await s.call("GET", "/api/cvs")).json.cvs.length, 1);
  } finally { s.close(); }
});

test("mail settings are stored encrypted and never returned; check fails clearly without a login", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    assert.equal((await s.call("GET", "/api/mail")).json.configured, false);
    assert.equal((await s.call("PUT", "/api/mail", { user: "me@gmail.com" })).status, 400, "password required the first time");
    const saved = await s.call("PUT", "/api/mail", { user: "me@gmail.com", password: "abcd efgh ijkl mnop", folders: "INBOX, Jobs", skip: "turing" });
    assert.equal(saved.status, 200); assert.equal(saved.json.host, "imap.gmail.com"); assert.deepEqual(saved.json.folders, ["INBOX", "Jobs"]);
    assert.ok(!JSON.stringify(saved.json).includes("abcd"));
    const raw = s.db.prepare("SELECT pass_enc FROM mail_accounts").get().pass_enc; assert.ok(!raw.includes("abcd"));
    assert.equal((await s.call("PUT", "/api/mail", { user: "me@gmail.com", host: "imap.gmail.com" })).status, 200, "password kept when left blank");
    assert.equal((await s.call("GET", "/api/mail/review")).json.items.length, 0);
    assert.equal((await s.call("DELETE", "/api/mail")).status, 200);
    assert.equal((await s.call("GET", "/api/mail")).json.configured, false);
    assert.equal((await s.call("POST", "/api/mail/check", {})).status, 400, "nothing connected");
  } finally { s.close(); }
});

test("settings: schedule is validated, feeds can be switched off, boards are checked before they are added", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    const st = (await s.call("GET", "/api/settings")).json;
    assert.equal(st.schedule.hour, 8); assert.ok(st.boards.length >= 15); assert.ok(st.feeds.includes("remoteok"));
    const up = (await s.call("PUT", "/api/settings", { schedule: { hour: 99, mailEveryMinutes: 1 }, feedsOff: ["jobicy", "bogus"], webhook: "https://ntfy.sh/mytopic" })).json;
    assert.equal(up.schedule.hour, 23); assert.equal(up.schedule.mailEveryMinutes, 5); assert.deepEqual(up.feedsOff, ["jobicy"]); assert.equal(up.webhook, "https://ntfy.sh/mytopic");
    assert.equal((await s.call("PUT", "/api/settings", { webhook: "ftp://x" })).status, 400);
    assert.equal((await s.call("POST", "/api/boards", { ats: "nope", slug: "x" })).status, 400);
    assert.equal((await s.call("POST", "/api/boards", { ats: "lever", slug: "../etc" })).status, 400);
  } finally { s.close(); }
});

test("digest lists new fits and replies, and the webhook speaks ntfy, Discord and Slack", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    await s.call("PUT", "/api/profile", PM);
    ingest(s.db, [ACME]);
    await s.call("POST", "/api/rematch");
    const uid = s.db.prepare("SELECT id FROM users").get().id;
    s.db.prepare("INSERT INTO applications (user_id, company, role, status, unread, added, updated) VALUES (?, 'Globex', 'PM', 'Replied', 1, 'x', 'x')").run(uid);
    const d = buildDigest(s.db, uid, new Date(Date.now() - 864e5).toISOString());
    assert.equal(d.newCount, 1); assert.equal(d.unread, 1); assert.match(d.text, /Product Manager at Acme/); assert.match(d.text, /Globex/);
    const sent = [];
    const f = async (u, o) => { sent.push({ host: u.hostname, ...o }); return { ok: true }; };
    await sendWebhook("https://ntfy.sh/t", "Hi", "body", f); await sendWebhook("https://discord.com/api/webhooks/1/x", "Hi", "body", f); await sendWebhook("https://hooks.slack.com/services/a", "Hi", "body", f);
    assert.equal(sent[0].body, "body"); assert.match(JSON.parse(sent[1].body).content, /Hi/); assert.match(JSON.parse(sent[2].body).text, /Hi/);
    await assert.rejects(() => sendWebhook("javascript:alert(1)", "x", "y", f), /http/);
    await assert.rejects(() => sendWebhook("https://ntfy.sh/t", "x", "y", async () => ({ ok: false, status: 500 })), /500/);
  } finally { s.close(); }
});

test("sweepAndNotify re-matches, stores the digest and pushes it when a webhook is set; schedule defaults hold", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    await s.call("PUT", "/api/profile", PM);
    await s.call("PUT", "/api/settings", { webhook: "https://ntfy.sh/t" });
    ingest(s.db, [ACME]);
    const pushed = [];
    await sweepAndNotify(s.db, { fetchSources: false, fetchImpl: async (u, o) => { pushed.push(o.body); return { ok: true }; } });
    assert.equal(pushed.length, 1); assert.match(pushed[0], /Acme/);
    assert.equal((await s.call("GET", "/api/digest")).json.digest.newCount, 1);
    assert.equal(setSchedule(s.db, { enabled: false }).enabled, false); assert.equal(getSchedule(s.db).hour, 8);
  } finally { s.close(); }
});

test("new source parsers", () => {
  const ok = S.parseRemoteOk([{ legal: "x" }, { id: "9", position: "Data Analyst", company: "Z", location: "Worldwide", salary_min: 50000, salary_max: 70000, date: "2026-11-05T00:00:00+00:00", url: "https://remoteok.com/9", description: "<p>We offer visa sponsorship</p>" }]);
  assert.equal(ok.length, 1); assert.equal(ok[0].salary.max, 70000); assert.equal(ok[0].sponsorship, true); assert.equal(ok[0].location, "Remote - Worldwide");
  const w = S.parseWwr("<rss><channel><item><title>Acme: Support Lead</title><region>Europe Only</region><type>Full-Time</type><description>&lt;p&gt;Help people&lt;/p&gt;</description><pubDate>Fri, 06 Nov 2026 04:39:12 +0000</pubDate><guid>https://wwr/1</guid><link>https://wwr/1</link></item></channel></rss>");
  assert.equal(w[0].company, "Acme"); assert.equal(w[0].title, "Support Lead"); assert.equal(w[0].location, "Remote - Europe"); assert.equal(w[0].employment, "full_time");
  const a = S.parseArbeitnow({ data: [{ slug: "s", company_name: "C", title: "Dev", description: "<p>x</p>", remote: false, url: "https://a/1", job_types: ["Part Time"], location: "Berlin", created_at: 1793936414 }] });
  assert.equal(a[0].location, "Berlin, Germany"); assert.equal(a[0].employment, "part_time");
  const j = S.parseJobicy({ jobs: [{ id: 1, url: "https://j/1", jobTitle: "Writer", companyName: "Co", jobType: ["Contract"], jobGeo: "Anywhere", jobDescription: "<p>hi</p>", pubDate: "2026-11-05T20:06:17+00:00", salaryMin: 20, salaryMax: 30, salaryCurrency: "EUR", salaryPeriod: "hourly" }] });
  assert.equal(j[0].location, "Remote - Worldwide"); assert.equal(j[0].salary.period, "hour"); assert.equal(j[0].employment, "contract");
  const wk = S.parseWorkable({ results: [{ shortcode: "AB12", title: "PM", remote: true, location: { country: "France" }, type: "part", published: "2026-09-21T00:00:00.000Z" }] }, "hf");
  assert.equal(wk[0].url, "https://apply.workable.com/hf/j/AB12/"); assert.equal(wk[0].employment, "part_time"); assert.equal(wk[0].location, "Remote - France");
  const rc = S.parseRecruitee({ offers: [{ guid: "g", title: "AML", company_name: "bunq", city: "Vienna", country: "Austria", location: "Vienna, Wien, Austria", max_hours: 20, careers_url: "https://c/1", description: "<p>x</p>", published_at: "2026-10-30 16:32:58 UTC" }] }, "bunq");
  assert.equal(rc[0].employment, "part_time"); assert.equal(rc[0].posted_at, "2026-10-30T16:32:58.000Z");
  const sr = S.parseSmartRecruiters({ content: [{ id: "1", name: "Analyst", company: { name: "Visa" }, location: { city: "Milan", country: "it" }, typeOfEmployment: { label: "Full-time" }, releasedDate: "2026-11-01T00:00:00Z" }] }, "Visa");
  assert.equal(sr[0].location, "Milan, IT"); assert.equal(sr[0].employment, "full_time");
});
