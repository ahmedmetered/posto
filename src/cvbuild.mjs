// The CV builder: one structured CV in, a one-page, ATS-friendly HTML out, and a PDF printed by the browser already on the machine
// (Edge or Chrome, headless). No library, no LaTeX. Everything is escaped on the way out, and nothing here sends anything anywhere.
// Layout rules adapted from the anyjobsearch builder (itself after ai-job-search): single column, standard section names, real text only,
// one page, and when it does not fit the weakest bullet goes, not the font size.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (v, n, each) => (Array.isArray(v) ? v : []).slice(0, n).map(each);
const bullets = v => list(v, 8, b => clip(b, 400)).filter(Boolean);

export const emptyCv = () => ({ lang: "en", name: "", headline: "", contact: { city: "", email: "", phone: "", linkedin: "", github: "", portfolio: "" }, summary: "", experience: [], projects: [], skills: [], education: [], languages: "" });

export function cleanCv(d = {}) {
  d = d && typeof d === "object" ? d : {}; const c = d.contact && typeof d.contact === "object" ? d.contact : {};
  return {
    lang: d.lang === "it" ? "it" : "en", name: clip(d.name, 120), headline: clip(d.headline, 160),
    contact: Object.fromEntries(["city", "email", "phone", "linkedin", "github", "portfolio"].map(k => [k, clip(c[k], 160)])),
    summary: clip(d.summary, 900),
    experience: list(d.experience, 12, e => ({ role: clip(e?.role, 140), employer: clip(e?.employer, 140), place: clip(e?.place, 100), dates: clip(e?.dates, 60), bullets: bullets(e?.bullets) })).filter(e => e.role || e.employer || e.bullets.length),
    projects: list(d.projects, 10, p => ({ name: clip(p?.name, 140), url: clip(p?.url, 200), status: clip(p?.status, 60), bullets: bullets(p?.bullets) })).filter(p => p.name || p.bullets.length),
    skills: list(d.skills, 12, s => clip(s, 300)).filter(Boolean),
    education: list(d.education, 8, e => ({ degree: clip(e?.degree, 160), school: clip(e?.school, 160), dates: clip(e?.dates, 60), note: clip(e?.note, 300) })).filter(e => e.degree || e.school),
    languages: clip(d.languages, 200),
  };
}

const LABELS = {
  en: { experience: "Experience", projects: "Selected work", skills: "Skills", education: "Education", languages: "Languages", title: "CV" },
  it: { experience: "Esperienza", projects: "Progetti", skills: "Competenze", education: "Formazione", languages: "Lingue", title: "CV" },
};
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderCvHtml(input, { pt = 10 } = {}) {
  const cv = cleanCv(input), L = LABELS[cv.lang], size = Math.min(Math.max(Number(pt) || 10, 8), 12);
  const contact = ["city", "email", "phone", "linkedin", "github", "portfolio"].map(k => cv.contact[k]).filter(Boolean).map(esc).join(" · ");
  const ul = b => (b.length ? `<ul>${b.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const entry = (role, when, where, b) => `<div class="entry"><div class="head"><span class="role">${esc(role)}</span><span class="when">${esc(when)}</span></div>${where ? `<p class="where">${esc(where)}</p>` : ""}${ul(b)}</div>`;
  const sec = (title, body) => (body ? `<h2>${title}</h2>${body}` : "");
  const body = [
    `<h1>${esc(cv.name || "Your name")}</h1>`, cv.headline ? `<p class="headline">${esc(cv.headline)}</p>` : "", contact ? `<p class="contact">${contact}</p>` : "", cv.summary ? `<p class="summary">${esc(cv.summary)}</p>` : "",
    sec(L.experience, cv.experience.map(e => entry(e.role, e.dates, [e.employer, e.place].filter(Boolean).join(", "), e.bullets)).join("")),
    sec(L.projects, cv.projects.map(p => entry([p.name, p.url && `(${p.url})`].filter(Boolean).join(" "), p.status, "", p.bullets)).join("")),
    sec(L.skills, cv.skills.length ? `<p class="skills">${cv.skills.map(esc).join("<br>")}</p>` : ""),
    sec(L.education, cv.education.map(e => entry(e.degree, e.dates, e.school, e.note ? [e.note] : [])).join("")),
    sec(L.languages, cv.languages ? `<p class="skills">${esc(cv.languages)}</p>` : ""),
  ].join("\n");
  return `<!DOCTYPE html>
<html lang="${cv.lang}"><head><meta charset="utf-8"><title>${esc(cv.name || "CV")} - ${L.title}</title>
<style>
  @page { size: A4; margin: 14mm 16mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #111; background: #fff; font-size: ${size}pt; line-height: 1.4; }
  @media screen { body { width: 210mm; padding: 14mm 16mm; margin: 0 auto; } }
  h1 { font-size: 20pt; font-weight: 700; letter-spacing: -0.01em; }
  .headline { font-size: 11pt; color: #333; margin-top: 0.5mm; }
  .contact { font-size: 9pt; color: #444; margin: 1.5mm 0 4mm; }
  .summary { margin-bottom: 3mm; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #999; padding-bottom: 1mm; margin: 5mm 0 2.5mm; }
  .entry { margin-bottom: 3mm; break-inside: avoid; }
  .head { display: flex; justify-content: space-between; gap: 4mm; }
  .role { font-weight: 600; }
  .when { color: #555; font-size: 9.5pt; white-space: nowrap; }
  .where { color: #555; font-size: 9.5pt; font-style: italic; }
  ul { margin: 1mm 0 0 5mm; }
  li { margin-bottom: 0.8mm; }
</style></head>
<body>
${body}
</body></html>
`;
}

// the same CV as plain text: what an ATS (or the keyword comparison in cv.mjs) will see
export function cvToText(input) {
  const cv = cleanCv(input), L = LABELS[cv.lang], out = [cv.name, cv.headline, Object.values(cv.contact).filter(Boolean).join(" · "), "", cv.summary];
  const block = (title, rows) => { if (rows.length) out.push("", title.toUpperCase(), ...rows); };
  block(L.experience, cv.experience.flatMap(e => [[e.role, [e.employer, e.place].filter(Boolean).join(", "), e.dates].filter(Boolean).join(" | "), ...e.bullets.map(b => "- " + b)]));
  block(L.projects, cv.projects.flatMap(p => [[p.name, p.url, p.status].filter(Boolean).join(" | "), ...p.bullets.map(b => "- " + b)]));
  block(L.skills, cv.skills);
  block(L.education, cv.education.flatMap(e => [[e.degree, e.school, e.dates].filter(Boolean).join(" | "), ...(e.note ? [e.note] : [])]));
  block(L.languages, cv.languages ? [cv.languages] : []);
  return out.filter((x, i) => x !== undefined && !(x === "" && out[i - 1] === "")).join("\n").trim();
}

// ---------- PDF ----------
export function findBrowser(env = process.env, exists = fs.existsSync) {
  const win = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"];
  const mac = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  const nix = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return [env.CHROME_BIN, ...win, ...mac, ...nix].filter(Boolean).find(p => { try { return exists(p); } catch { return false; } }) || "";
}
export const pdfPages = buf => Number((Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/) || Buffer.from(buf).toString("latin1").match(/\/Count\s+(\d+)/) || [])[1]) || 0;

export async function printPdf(html, { browser = findBrowser(), run = spawn, timeoutMs = 30000 } = {}) {
  if (!browser) throw Object.assign(new Error("No Chrome or Edge was found to print the PDF. Use \"Open printable page\" and print it to PDF from your browser, or set CHROME_BIN."), { status: 501 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posto-cv-")), src = path.join(dir, "cv.html"), out = path.join(dir, "cv.pdf");
  try {
    fs.writeFileSync(src, html);
    await new Promise((resolve, reject) => {
      const p = run(browser, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--user-data-dir=${path.join(dir, "profile")}`, `--print-to-pdf=${out}`, src], { stdio: "ignore" });
      const t = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } reject(new Error("The browser took too long to print the PDF.")); }, timeoutMs);
      p.on("error", e => { clearTimeout(t); reject(e); }); p.on("close", () => { clearTimeout(t); resolve(); });
    });
    for (let i = 0; i < 40 && !fs.existsSync(out); i++) await new Promise(r => setTimeout(r, 250)); // headless can write the file just after it exits
    if (!fs.existsSync(out)) throw new Error("The browser did not produce a PDF.");
    await new Promise(r => setTimeout(r, 150));
    const pdf = fs.readFileSync(out); return { pdf, pages: pdfPages(pdf) };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* the browser may still hold its profile for a moment; the OS clears the temp folder later */ } }
}

// ---------- for an AI agent ----------
export const SCHEMA_TEXT = `{
  "lang": "en" or "it",
  "name": "", "headline": "",
  "contact": { "city": "", "email": "", "phone": "", "linkedin": "", "github": "", "portfolio": "" },
  "summary": "two or three plain sentences",
  "experience": [ { "role": "", "employer": "", "place": "", "dates": "", "bullets": ["", ""] } ],
  "projects": [ { "name": "", "url": "", "status": "", "bullets": [""] } ],
  "skills": ["Group: item, item, item"],
  "education": [ { "degree": "", "school": "", "dates": "", "note": "" } ],
  "languages": ""
}`;
export const BUILDER_RULES = `Return ONLY one JSON object in exactly this shape, with no text before or after it:\n${SCHEMA_TEXT}\nRules: use only facts that are in the CV; never invent employers, dates, numbers, degrees or skills. One page, so at most 4 bullets per role and 2 per project; if it will not fit, cut the weakest bullet. Lead with evidence (shipped work, live products, repositories with tests). Keep dates, grades and numbers exact. Plain text, no markdown, no line breaks inside a value.`;

export const convertBrief = cvText => `You convert a CV into structured data without changing what it says. Use only what the CV contains.\n${BUILDER_RULES}\n\n=== CV ===\n${String(cvText).slice(0, 12000)}`;
