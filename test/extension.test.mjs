import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jobapp-"));
const { openDb } = await import("../src/db.mjs");
const { createApp } = await import("../src/server.mjs");
const { extractJob } = await import("../extension/extract.mjs");

test("extractJob reads schema.org JobPosting, LinkedIn and Indeed titles, and spots Easy Apply", () => {
  const ld = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Product Manager","hiringOrganization":{"@type":"Organization","name":"Acme &amp; Co"},
    "jobLocation":{"address":{"addressLocality":"Milan","addressCountry":"IT"}},"description":"<p>Own the <b>roadmap</b></p><p>Work with SQL</p>"}</script></head><body>Easy Apply</body></html>`;
  const a = extractJob(ld, "https://www.linkedin.com/jobs/view/1");
  assert.equal(a.title, "Product Manager"); assert.equal(a.company, "Acme & Co"); assert.equal(a.location, "Milan, IT"); assert.match(a.description, /roadmap\nWork with SQL/); assert.equal(a.easy, true); assert.equal(a.source, "LinkedIn");
  const remote = extractJob(`<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"JobPosting","title":"QA","hiringOrganization":"Z","jobLocationType":"TELECOMMUTE"}]}</script>`, "https://x.com/j");
  assert.equal(remote.title, "QA"); assert.equal(remote.location, "Remote");
  const li = extractJob("<title>Globex hiring Data Analyst in Rome, Lazio, Italy | LinkedIn</title>", "https://www.linkedin.com/jobs/view/2");
  assert.deepEqual([li.title, li.company, li.location], ["Data Analyst", "Globex", "Rome, Lazio, Italy"]);
  const ind = extractJob("<title>Product Builder - Globex Corp - Milano, Lombardia - Indeed.com</title><div>Candidati facilmente</div>", "https://it.indeed.com/viewjob?jk=1");
  assert.deepEqual([ind.title, ind.company, ind.location, ind.easy, ind.source], ["Product Builder", "Globex Corp", "Milano, Lombardia", true, "Indeed"]);
  assert.equal(extractJob("<html></html>", "").title, "");
});

function boot() {
  const db = openDb(":memory:"), server = http.createServer(createApp(db));
  return new Promise(r => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`; let sid = "";
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(sid ? { cookie: `sid=${sid}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get("set-cookie"); if (sc) { const m = sc.match(/sid=([^;]*)/); sid = m ? m[1] : ""; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, res };
    };
    r({ db, call, close: () => server.close() });
  }));
}

test("extension token: created once, works from another origin, checks and saves a job, can be revoked", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    await s.call("PUT", "/api/profile", { home_country: "IT", max_hours_week: 20, employment: ["part_time", "internship", "full_time"], tracks: [{ name: "Product", keywords: ["product manager"], cv: "Product EN" }], seniority_max: "mid" });
    const { token } = (await s.call("POST", "/api/token")).json; assert.match(token, /^jst_/);
    assert.ok(!JSON.stringify((await s.call("GET", "/api/settings")).json).includes(token), "the token itself is never shown again");
    assert.equal((await s.call("GET", "/api/settings")).json.hasToken, true);
    const ext = { authorization: "Bearer " + token, origin: "chrome-extension://abcdef" };
    assert.equal((await s.call("GET", "/api/ext/ping", null, ext)).json.email, "a@example.com");
    assert.equal((await s.call("GET", "/api/ext/ping", null, { authorization: "Bearer jst_wrongwrongwrongwrongwrong" })).status, 401);
    assert.equal((await s.call("GET", "/api/ext/ping")).status, 401);
    assert.equal((await s.call("GET", "/api/applications", null, ext)).status, 200, "cookie session still works for the normal API");

    const job = { title: "Product Manager", company: "Acme", location: "Remote - Worldwide", url: "https://www.linkedin.com/jobs/view/1", description: "Own the roadmap.", easy: true, source: "LinkedIn" };
    const c = (await s.call("POST", "/api/ext/check", job, ext)).json;
    assert.ok(c.result.reasons.length); assert.equal(c.existing, null); assert.equal(c.result.track.cv, "Product EN");
    const saved = await s.call("POST", "/api/ext/import", job, ext); assert.equal(saved.status, 201); assert.equal(saved.json.existing, false);
    const again = await s.call("POST", "/api/ext/import", job, ext); assert.equal(again.json.existing, true);
    const app = s.db.prepare("SELECT * FROM applications").get(); assert.equal(app.company, "Acme"); assert.equal(app.easy, 1); assert.equal(app.cv, "Product EN"); assert.equal(app.status, "Found");
    assert.equal((await s.call("POST", "/api/ext/import", { company: "x" }, ext)).status, 400);
    assert.equal((await s.call("POST", "/api/ext/import", { ...job, url: "javascript:alert(1)", title: "Other role" }, ext)).status, 201);
    assert.equal(s.db.prepare("SELECT url FROM applications WHERE role = 'Other role'").get().url, "");

    // a normal page cannot use the cookie from another origin, but the extension route is open to tokens only
    assert.equal((await s.call("POST", "/api/applications", { company: "X", role: "Y" }, { origin: "https://evil.example" })).status, 403);
    await s.call("DELETE", "/api/token");
    assert.equal((await s.call("GET", "/api/ext/ping", null, ext)).status, 401);
  } finally { s.close(); }
});
