import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db.mjs";
import { createApp } from "../src/server.mjs";
import { ingest, matchUser } from "../src/sweep.mjs";
import { parseGreenhouse, parseAshby, parseLever, parseHimalayas, parseRemotive } from "../src/sources/index.mjs";

function boot() {
  const db = openDb(":memory:"), server = http.createServer(createApp(db));
  return new Promise(r => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = () => { let sid = ""; return async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(sid ? { cookie: `sid=${sid}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get("set-cookie"); if (sc) { const m = sc.match(/sid=([^;]*)/); sid = m ? m[1] : ""; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text, res };
    }; };
    r({ db, server, client, base, close: () => server.close() });
  }));
}

const JOBS = [
  { source: "t", ext_id: "1", company: "Acme", title: "Junior Product Manager", location: "Milan, Italy", url: "https://x/1", employment: "part_time", description: "Join our product team.", posted_at: new Date().toISOString() },
  { source: "t", ext_id: "2", company: "Globex", title: "Product Manager", location: "Remote - Worldwide", url: "https://x/2", remote: true, description: "We offer visa sponsorship.", posted_at: new Date().toISOString() },
  { source: "t", ext_id: "3", company: "Initech", title: "Product Manager", location: "Remote (United States)", url: "https://x/3", remote: true, posted_at: new Date().toISOString() },
  { source: "t", ext_id: "4", company: "Umbrella", title: "Warehouse Operator", location: "Milan, Italy", url: "https://x/4", posted_at: new Date().toISOString() },
];

test("sign up, profile, feed, tracker, isolation, export and delete", async () => {
  const s = await boot(); const a = s.client(), b = s.client();
  try {
    assert.equal((await a("GET", "/api/me")).status, 401);
    assert.equal((await a("POST", "/api/signup", { email: "a@example.com", password: "short" })).status, 400);
    assert.equal((await a("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" })).status, 201);
    assert.equal((await a("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" })).status, 409);
    assert.equal((await b("POST", "/api/signup", { email: "b@example.com", password: "another long password" })).status, 201);

    ingest(s.db, JOBS);
    assert.equal(ingest(s.db, JOBS), 0, "re-ingesting adds nothing");

    const me = (await a("GET", "/api/me")).json; assert.equal(me.profile, null);
    assert.equal((await a("PUT", "/api/profile", { home_country: "" })).status, 400);
    const put = await a("PUT", "/api/profile", { home_country: "IT", max_hours_week: 20, tracks: [{ name: "Product", keywords: ["product manager"], cv: "Product EN" }], seniority_max: "mid" });
    assert.equal(put.status, 200);
    assert.ok(put.json.stats.fit >= 1 || put.json.stats.check >= 1);

    const feed = (await a("GET", "/api/feed")).json;
    const titles = feed.jobs.map(j => j.company);
    assert.ok(titles.includes("Acme")); assert.ok(titles.includes("Globex"));
    assert.ok(!titles.includes("Initech"), "US-only remote is blocked for an Italy-based user");
    assert.ok(!titles.includes("Umbrella"), "off-track role is blocked");
    assert.equal(feed.jobs.find(j => j.company === "Acme").cv, "Product EN");

    assert.equal((await b("GET", "/api/feed")).json.total, 0, "another user has no feed");

    const acme = feed.jobs.find(j => j.company === "Acme");
    const tr = await a("POST", `/api/feed/${acme.id}/track`); assert.equal(tr.status, 201);
    assert.equal((await a("POST", `/api/feed/${acme.id}/track`)).json.existing, true);
    const apps = (await a("GET", "/api/applications")).json.applications; assert.equal(apps.length, 1); assert.equal(apps[0].cv, "Product EN");
    assert.equal((await b("GET", "/api/applications")).json.applications.length, 0);
    assert.equal((await b("PATCH", `/api/applications/${apps[0].id}`, { status: "Applied" })).status, 404, "cannot touch another user's application");

    const up = await a("PATCH", `/api/applications/${apps[0].id}`, { status: "Applied" });
    assert.equal(up.json.status, "Applied"); assert.ok(up.json.date_applied);
    assert.equal((await a("PATCH", `/api/applications/${apps[0].id}`, { status: "Nonsense" })).status, 400);

    const msg = { messages: [{ id: "m1", dir: "in", platform: "email", text: "Thanks, we'd like to talk", ts: new Date().toISOString() }] };
    assert.equal((await a("POST", `/api/applications/${apps[0].id}/messages`, msg)).json.added, 1);
    assert.equal((await a("POST", `/api/applications/${apps[0].id}/messages`, msg)).json.added, 0, "same message id is not stored twice");
    const ins = (await a("GET", "/api/insights")).json; assert.equal(ins.sent, 1); assert.equal(ins.byCv["Product EN"].sent, 1);

    const ex = await a("GET", "/api/export"); assert.equal(ex.json.applications.length, 1);
    assert.equal((await a("POST", "/api/account/delete", { password: "wrong" })).status, 403);
    assert.equal((await a("POST", "/api/account/delete", { password: "correct horse battery" })).status, 200);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM applications").get().n, 0, "account deletion removes the data");
  } finally { s.close(); }
});

test("login, logout, wrong password, cross-site writes are refused", async () => {
  const s = await boot(); const a = s.client();
  try {
    await a("POST", "/api/signup", { email: "c@example.com", password: "a long enough pass" });
    await a("POST", "/api/logout"); assert.equal((await a("GET", "/api/me")).status, 401);
    assert.equal((await a("POST", "/api/login", { email: "c@example.com", password: "nope nope nope" })).status, 401);
    assert.equal((await a("POST", "/api/login", { email: "c@example.com", password: "a long enough pass" })).status, 200);
    assert.equal((await a("GET", "/api/me")).status, 200);
    const cross = await a("POST", "/api/applications", { company: "X", role: "Y" }, { origin: "https://evil.example" });
    assert.equal(cross.status, 403);
    assert.equal((await a("GET", "/../package.json")).status, 404, "no path traversal");
  } finally { s.close(); }
});

test("source parsers normalise real-world shapes", () => {
  const gh = parseGreenhouse({ jobs: [{ id: 1, title: "PM", location: { name: "Milan, Italy" }, absolute_url: "https://g/1", content: "<p>We offer visa sponsorship</p>", updated_at: "2026-11-01T10:00:00Z" }] }, "acme");
  assert.equal(gh[0].sponsorship, true); assert.equal(gh[0].location, "Milan, Italy");
  const ab = parseAshby({ jobs: [{ id: "a", title: "PM", location: "Remote", isRemote: true, employmentType: "FullTime", jobUrl: "https://a/1", descriptionPlain: "no visa sponsorship available", publishedAt: "2026-11-01" }] }, "alan");
  assert.equal(ab[0].remote, true); assert.equal(ab[0].employment, "full_time"); assert.equal(ab[0].sponsorship, false);
  const lv = parseLever([{ id: "l", text: "QA", categories: { location: "Berlin", commitment: "Intern" }, workplaceType: "on-site", hostedUrl: "https://l/1", createdAt: 1762000000000, descriptionPlain: "x" }], "co");
  assert.equal(lv[0].employment, "internship"); assert.equal(lv[0].remote, false);
  const hm = parseHimalayas({ jobs: [{ guid: "h1", title: "APM", companyName: "H", locationRestrictions: ["Italy", "Spain"], applicationLink: "https://h/1", employmentType: "Full Time", pubDate: 1762000000 }] });
  assert.equal(hm[0].location, "Remote - Italy, Spain");
  const rm = parseRemotive({ jobs: [{ id: 5, title: "PM", company_name: "R", candidate_required_location: "Europe", url: "https://r/5", job_type: "full_time", publication_date: "2026-11-01T00:00:00", description: "<b>hi</b>" }] });
  assert.equal(rm[0].location, "Remote - Europe");
});
