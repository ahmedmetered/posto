import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jobapp-"));
const { openDb } = await import("../src/db.mjs");
const { createApp } = await import("../src/server.mjs");
const { ingest } = await import("../src/sweep.mjs");
const B = await import("../src/cvbuild.mjs");

const CV = {
  lang: "en", name: "Ada <b>Lovelace</b>", headline: "Product builder", contact: { city: "Milan", email: "ada@example.com", github: "github.com/ada" },
  summary: "Ships working software with AI and verifies it before it goes out.",
  experience: [{ role: "QA Analyst", employer: "Airline", place: "Rome", dates: "2022 - 2025", bullets: ["Root-cause analysis across channels", "Wrote regression suites"] }],
  projects: [{ name: "Posto", url: "github.com/x/posto", status: "open source", bullets: ["Local-first job search app"] }],
  skills: ["Product: discovery, roadmaps", "Tools: SQL, Playwright"], education: [{ degree: "BSc Computer Science", school: "Uni", dates: "2018 - 2021", note: "" }], languages: "English, Italian",
};

test("cleanCv caps and drops junk; renderCvHtml escapes everything and keeps the section order", () => {
  const c = B.cleanCv({ ...CV, experience: [...CV.experience, { role: "", employer: "", bullets: [] }], skills: [123, "ok"], extra: "<script>" });
  assert.equal(c.experience.length, 1); assert.equal(c.extra, undefined); assert.deepEqual(c.skills, ["123", "ok"]);
  const html = B.renderCvHtml(CV);
  assert.ok(!html.includes("<b>Lovelace"), "name is escaped"); assert.match(html, /Ada &lt;b&gt;Lovelace/);
  const order = ["Experience", "Selected work", "Skills", "Education", "Languages"].map(s => html.indexOf(`<h2>${s}</h2>`)); assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]));
  assert.match(B.renderCvHtml({ ...CV, lang: "it" }), /<h2>Esperienza<\/h2>/); assert.match(html, /font-size: 10pt/);
  assert.equal(B.renderCvHtml({}).includes("Your name"), true, "an empty CV still renders");
});

test("cvToText gives the plain text an ATS or the keyword comparison would read", () => {
  const t = B.cvToText(CV); assert.match(t, /^Ada <b>Lovelace<\/b>\nProduct builder\nMilan · ada@example.com · github.com\/ada/); assert.match(t, /EXPERIENCE\nQA Analyst \| Airline, Rome \| 2022 - 2025\n- Root-cause analysis across channels/); assert.match(t, /SKILLS\nProduct: discovery, roadmaps/); assert.ok(!/\n\n\n/.test(t));
});

test("printPdf: finds a browser, passes a private profile, waits for the file, counts pages, and cleans up; says so when there is no browser", async () => {
  await assert.rejects(() => B.printPdf("<p>x</p>", { browser: "" }), /No Chrome or Edge/);
  let args; const run = (bin, a) => { args = a; const out = a.find(x => x.startsWith("--print-to-pdf=")).slice(15); setTimeout(() => fs.writeFileSync(out, "%PDF-1.4\n<< /Type /Pages /Kids [] /Count 2 >>"), 50); const p = new EventEmitter(); setTimeout(() => p.emit("close", 0), 10); return p; };
  const r = await B.printPdf("<p>x</p>", { browser: "fake", run });
  assert.equal(r.pages, 2); assert.ok(args.some(a => a.startsWith("--user-data-dir=")) && args.includes("--headless") && args.includes("--no-pdf-header-footer"));
  assert.equal(B.findBrowser({ CHROME_BIN: "/x/chrome" }, p => p === "/x/chrome"), "/x/chrome"); assert.equal(B.findBrowser({}, () => false), "");
  assert.equal(B.pdfPages(Buffer.from("<< /Type /Pages /Count 1 >>")), 1);
});

function boot() {
  const db = openDb(":memory:"), server = http.createServer(createApp(db, {}));
  return new Promise(r => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`; let sid = "";
    const call = async (method, p, body, raw = false) => {
      const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(sid ? { cookie: `sid=${sid}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get("set-cookie"); if (sc) { const m = sc.match(/sid=([^;]*)/); sid = m ? m[1] : ""; }
      if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
    r({ db, call, close: () => server.close() });
  }));
}

test("CV builder API: save, list, render, brief, the CV shows up for job matching, delete; and a real PDF when a browser is installed", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    assert.equal((await s.call("PUT", "/api/cv-builds", { name: "", data: CV })).status, 400);
    assert.equal((await s.call("PUT", "/api/cv-builds", { name: "Empty", data: {} })).status, 400);
    const saved = (await s.call("PUT", "/api/cv-builds", { name: "Product EN", data: CV })).json; assert.ok(saved.id); assert.equal(saved.data.name, "Ada <b>Lovelace</b>");
    const again = (await s.call("PUT", "/api/cv-builds", { id: saved.id, name: "Product EN 2", data: { ...CV, headline: "Changed" } })).json; assert.equal(again.id, saved.id); assert.equal(again.data.headline, "Changed");
    assert.equal((await s.call("GET", "/api/cv-builds")).json.builds.length, 1);
    assert.equal((await s.call("GET", `/api/cv-builds/${saved.id}`)).json.name, "Product EN 2");
    const cvs = (await s.call("GET", "/api/cvs")).json.cvs; assert.ok(cvs.some(c => c.name === "Built: Product EN 2"), "built CVs join the job comparison");
    const rend = (await s.call("POST", "/api/cv-render", { data: CV })).json; assert.match(rend.html, /<h1>Ada &lt;b&gt;/); assert.match(rend.text, /EXPERIENCE/);
    await s.call("PUT", "/api/cvs", { name: "Old CV", text: "Product manager with five years of discovery and roadmap work for B2B software." });
    const brief = (await s.call("GET", "/api/cv-builds/brief?cv=Old%20CV")).json.brief; assert.match(brief, /"experience"/); assert.match(brief, /Product manager with five years/); assert.match(brief, /never invent/i);
    assert.equal((await s.call("GET", "/api/cv-builds/brief?cv=Nope")).status, 400);
    const pdf = await s.call("GET", `/api/cv-builds/${saved.id}/pdf`, undefined, true);
    if (B.findBrowser()) { assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("content-type"), "application/pdf"); assert.equal(pdf.buf.subarray(0, 4).toString(), "%PDF"); assert.equal(pdf.headers.get("x-cv-pages"), "1", "the sample CV fits one page"); }
    else assert.equal(pdf.status, 501);
    assert.equal((await s.call("DELETE", `/api/cv-builds/${saved.id}`)).status, 200); assert.equal((await s.call("GET", `/api/cv-builds/${saved.id}`)).status, 404);
    assert.ok(!(await s.call("GET", "/api/cvs")).json.cvs.some(c => c.name.startsWith("Built:")), "its matching copy goes with it");
  } finally { s.close(); }
});

test("a tailoring brief for the builder asks for the schema and carries the posting and the CV", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    await s.call("PUT", "/api/profile", { home_country: "IT", tracks: [{ name: "Product", keywords: ["product manager"], cv: "Product EN" }], seniority_max: "senior" });
    ingest(s.db, [{ source: "t", ext_id: "1", company: "Acme", title: "Product Manager", location: "Remote - Worldwide", remote: true, url: "https://x/1", employment: "full_time", description: "Own the roadmap and run user research.", posted_at: new Date().toISOString() }]);
    await s.call("POST", "/api/rematch"); const id = (await s.call("GET", "/api/feed")).json.jobs[0].id;
    await s.call("PUT", "/api/cvs", { name: "Product EN", text: "Product manager with five years running discovery, user research and roadmap planning." });
    const b = (await s.call("GET", `/api/feed/${id}/brief?kind=cv_json&cv=Product%20EN`)).json.brief;
    assert.match(b, /"lang": "en" or "it"/); assert.match(b, /Product Manager at Acme/); assert.match(b, /five years running discovery/);
  } finally { s.close(); }
});
