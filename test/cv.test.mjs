import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { jobTerms, compareCv, rankCvs, docxText, pdfText, textFromUpload } from "../src/cv.mjs";
import { tailor, aiConfigFromInput } from "../src/ai.mjs";

const job = { title: "Product Manager", company: "Acme", description: "You will own the roadmap, run user research and discovery, write PRDs, and work with SQL and analytics. Experience with A/B testing and Jira. Roadmap ownership matters. User research is core." };
const cvPm = "Product manager with five years running discovery, user research, roadmap planning and analytics. Wrote PRDs. SQL daily. Jira.";
const cvQa = "QA engineer. Test automation with Playwright, Selenium, CI pipelines, API testing, regression suites.";

test("jobTerms keeps title and repeated terms, drops filler", () => {
  const t = jobTerms(job);
  assert.ok(t.includes("roadmap")); assert.ok(t.includes("product")); assert.ok(!t.includes("will"));
});

test("compareCv shows what matches and what is missing", () => {
  const r = compareCv(cvPm, job);
  assert.ok(r.matched.includes("roadmap")); assert.ok(r.coverage > 40);
  const q = compareCv(cvQa, job);
  assert.ok(q.coverage < r.coverage); assert.ok(q.missing.includes("roadmap"));
});

test("rankCvs picks the CV that covers the posting, track pick breaks ties", () => {
  const ranked = rankCvs([{ name: "QA", text: cvQa }, { name: "PM", text: cvPm }], job);
  assert.equal(ranked[0].name, "PM");
  const tie = rankCvs([{ name: "A", text: "x" }, { name: "B", text: "x" }], job, "B");
  assert.equal(tie[0].name, "B");
});

function zipOf(name, content) { // minimal one-file zip, deflated
  const data = zlib.deflateRawSync(Buffer.from(content)), nm = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(content.length, 22); lh.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(content.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + nm.length, 12); eo.writeUInt32LE(30 + nm.length + data.length, 16);
  return Buffer.concat([lh, nm, data, cd, nm, eo]);
}

test("reads text from a .docx and a text PDF, rejects unreadable files", () => {
  const xml = "<w:document><w:body><w:p><w:r><w:t>Jane Doe</w:t></w:r></w:p><w:p><w:r><w:t>Product manager &amp; analyst</w:t></w:r></w:p></w:body></w:document>";
  assert.match(docxText(zipOf("word/document.xml", xml)), /Jane Doe\nProduct manager & analyst/);
  const stream = zlib.deflateSync(Buffer.from("BT (Jane Doe) Tj [(Product ) 10 (manager)] TJ ET"));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nstream\n", "latin1"), stream, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
  assert.match(pdfText(pdf), /Jane Doe/); assert.match(pdfText(pdf), /Product manager/);
  assert.throws(() => textFromUpload("scan.pdf", Buffer.from("%PDF-1.4 nothing")), /Paste the text/);
  assert.throws(() => textFromUpload("cv.exe", Buffer.from("x")), /Upload a/);
  assert.match(textFromUpload("cv.txt", Buffer.from(cvPm + " " + cvQa)), /Product manager/);
});

test("tailor: builds a grounded prompt and parses both API shapes; fails without setup", async () => {
  let seen;
  const anth = async (url, o) => { seen = { url, body: JSON.parse(o.body), h: o.headers }; return { ok: true, json: async () => ({ content: [{ text: "Summary here" }] }) }; };
  const out = await tailor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", apiKey: "k" }, "summary", { cv: cvPm, job }, anth);
  assert.equal(out, "Summary here"); assert.equal(seen.h["x-api-key"], "k"); assert.match(seen.body.system, /Never invent/); assert.match(seen.body.messages[0].content, /Product Manager at Acme/);
  const oai = async (url) => { seen = { url }; return { ok: true, json: async () => ({ choices: [{ message: { content: "Letter" } }] }) }; };
  assert.equal(await tailor({ provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "x" }, "cover_letter", { cv: cvPm, job }, oai), "Letter");
  assert.match(seen.url, /\/chat\/completions$/);
  await assert.rejects(() => tailor(null, "summary", { cv: cvPm, job }), /Settings/);
  await assert.rejects(() => tailor({ provider: "openai", baseUrl: "x", model: "m" }, "summary", { cv: cvPm, job }, async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) })), /bad key/);
  assert.equal(aiConfigFromInput({ provider: "nope" }), null); assert.equal(aiConfigFromInput({ provider: "ollama" }).model, "llama3.1");
});
