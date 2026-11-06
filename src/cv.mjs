// CVs: read text out of an upload, compare a CV with a job posting, pick the best CV for a role.
// Everything here is local and deterministic. The optional AI step lives in ai.mjs.
import zlib from "node:zlib";

const STOP = new Set(("a about above across after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its me more most my no nor not of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your " +
  "make makes making get gets getting take taking love like want wants turn turning real great best key passion passionate opportunity opportunities mission culture benefits based across people person people value values decisions decision day days time things thing way ways every many much lot just really even also still next first one two three part full around together everything everyone someone something anything high level top large small big open right left real life live world today future now here there look looks seeking seek hire hiring apply applying application equal employer remote hybrid onsite location locations office offices headquarters url " +
  "experience experienced work working team teams role roles job position company candidate candidates ability skills skill strong required requirements responsibilities looking join years year must plus etc including include within across using use used new help support ensure build building highly well great good able need needs").split(" "));
// short terms that matter in a CV even though they are 2 letters
const KEEP_SHORT = new Set(["qa", "ai", "ml", "bi", "ux", "ui", "pm", "hr", "it", "c#", "c++", "go", "r", "sql", "seo", "crm", "erp", "api", "aws", "gcp", "b2b", "b2c", "saas", "kpi", "okr"]);

const tokens = text => (String(text).toLowerCase().match(/[a-z][a-z0-9+#.]*[a-z0-9+#]|[a-z]/g) || []).map(w => w.replace(/\.+$/, ""));
const keep = w => KEEP_SHORT.has(w) || (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

// the terms a posting is asking for: words and two-word phrases, weighted by where they appear and how often
export function jobTerms(job, limit = 30) {
  const score = new Map(), add = (w, n) => score.set(w, (score.get(w) || 0) + n);
  const feed = (text, weight) => {
    const t = tokens(text);
    for (let i = 0; i < t.length; i++) {
      if (keep(t[i])) add(t[i], weight);
      if (i + 1 < t.length && keep(t[i]) && keep(t[i + 1])) add(`${t[i]} ${t[i + 1]}`, weight * 0.8);
    }
  };
  feed(job.title || "", 4); feed(job.description || "", 1);
  // a term seen once in a long description is noise; keep what is in the title or repeated
  return [...score.entries()].filter(([w, s]) => s >= 2 || (job.title || "").toLowerCase().includes(w)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

export function compareCv(cvText, job) {
  const cv = String(cvText || "").toLowerCase(), set = new Set(tokens(cv));
  const terms = jobTerms(job), matched = [], missing = [];
  for (const term of terms) {
    const words = term.split(" ");
    const hit = words.length === 1 ? set.has(term) || cv.includes(term) && term.length > 3 : cv.includes(term);
    (hit ? matched : missing).push(term);
  }
  // two-word terms duplicate their parts, so keep the list readable
  const single = list => list.filter(t => !list.some(o => o !== t && o.includes(" ") && o.split(" ").includes(t)));
  const coverage = terms.length ? Math.round(100 * matched.length / terms.length) : 0;
  return { coverage, matched: single(matched).slice(0, 15), missing: single(missing).slice(0, 15), terms: terms.length };
}

// rank the user's CVs for one job: best coverage first; the CV tied to the matching track wins ties
export function rankCvs(cvs, job, trackCv = null) {
  return cvs.map(c => ({ name: c.name, ...compareCv(c.text, job), trackPick: c.name === trackCv }))
    .sort((a, b) => b.coverage - a.coverage || (b.trackPick ? 1 : 0) - (a.trackPick ? 1 : 0));
}

// ---------- reading uploads ----------
// .docx is a zip with word/document.xml; read it with the standard library only
export function docxText(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("This does not look like a .docx file.");
  const count = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (name === "word/document.xml") {
      const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(lh, lh + csize);
      const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
      return xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error("No text found inside the .docx file.");
}

// Text out of a PDF. Handles what browsers and word processors produce: Flate-compressed content streams, and fonts that
// show glyph numbers instead of letters (Chrome/Skia "Print to PDF", Word, LibreOffice), which are translated back
// through each font's ToUnicode table. Scanned PDFs have no text and come back empty.
const inflate = b => { try { return zlib.inflateSync(b); } catch { return b; } };
const utf16 = hex => { let s = ""; for (let i = 0; i + 3 < hex.length + 1; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)); return s; };
function parseCMap(txt) {
  const map = new Map();
  for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), utf16(m[2].padStart(4, "0")));
  for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
    const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
    if (m[3][0] === "[") [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => map.set(lo + i, utf16(d[1].padStart(4, "0"))));
    else { const base = m[3].slice(1, -1).padStart(4, "0"), head = utf16(base.slice(0, -4)), last = parseInt(base.slice(-4), 16); for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, head + String.fromCharCode(last + c - lo)); }
  }
  return map;
}
const litDecode = q => q.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: "\n", r: "", t: " ", b: "", f: "" }[c] ?? c)).replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

export function pdfText(buf) {
  const s = buf.toString("latin1");
  const objs = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) objs.set(+m[1], m[2]);
  const streamOf = body => { const m = body && body.match(/stream\r?\n([\s\S]*?)\r?\nendstream/); return m ? inflate(Buffer.from(m[1], "latin1")) : null; };
  // font name (/F4) -> its ToUnicode table
  const cmapOfObj = new Map();
  for (const [n, body] of objs) { const tu = body.match(/\/ToUnicode\s+(\d+) 0 R/); if (tu) { const st = streamOf(objs.get(+tu[1])); if (st) cmapOfObj.set(n, parseCMap(st.toString("latin1"))); } }
  const fontByName = new Map();
  for (const body of objs.values()) {
    for (const f of body.matchAll(/\/Font\s*(?:<<([^>]*(?:<<[^>]*>>[^>]*)*)>>|(\d+) 0 R)/g)) {
      const dict = f[1] ?? objs.get(+f[2]) ?? "";
      for (const p of dict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+) 0 R/g)) if (cmapOfObj.has(+p[2])) fontByName.set(p[1], cmapOfObj.get(+p[2]));
    }
  }
  const out = [];
  const tok = /\/([^\s/<>[\]()]+)\s+[\d.]+\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|T\*|\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F\s]*)>\s*Tj|\(((?:[^)\\]|\\.)*)\)\s*Tj/g;
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const text = inflate(Buffer.from(m[1], "latin1")).toString("latin1");
    if (!/\bBT\b/.test(text)) continue;
    let cmap = null, y = null, lastY = null;
    const emit = str => { if (!str) return; if (lastY !== null && y !== null && Math.abs(y - lastY) > 1 && out.length && out[out.length - 1] !== "\n") out.push("\n"); lastY = y; out.push(str); };
    const hexOut = hex => { hex = hex.replace(/\s+/g, ""); let r = ""; const two = cmap && [...cmap.keys()].some(k => k > 255); const w = two ? 4 : 2; for (let i = 0; i + w <= hex.length; i += w) { const c = parseInt(hex.slice(i, i + w), 16); r += cmap ? (cmap.get(c) ?? "") : String.fromCharCode(c); } return r; };
    for (const t of text.matchAll(tok)) {
      if (t[1] !== undefined) cmap = fontByName.get(t[1]) || null;
      else if (t[7] !== undefined) y = +t[7];
      else if (t[9] !== undefined) y = (y ?? 0) + +t[9];
      else if (t[0] === "T*") y = (y ?? 0) + 1;
      else if (t[10] !== undefined) { let r = ""; for (const q of t[10].matchAll(/<([0-9a-fA-F\s]*)>|\(((?:[^)\\]|\\.)*)\)|(-?[\d.]+)/g)) r += q[1] !== undefined ? hexOut(q[1]) : q[2] !== undefined ? litDecode(q[2]) : +q[3] < -250 ? " " : ""; emit(r); }
      else if (t[11] !== undefined) emit(hexOut(t[11]));
      else if (t[12] !== undefined) emit(litDecode(t[12]));
    }
    out.push("\n");
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function textFromUpload(filename, buf) {
  const ext = String(filename).toLowerCase().split(".").pop();
  let text;
  if (ext === "docx") text = docxText(buf);
  else if (ext === "pdf") text = pdfText(buf);
  else if (["txt", "md", "text", "rtf"].includes(ext)) text = buf.toString("utf8");
  else throw new Error("Upload a .docx, .pdf, .txt or .md file, or paste the text.");
  if ((text.match(/[a-zA-Z]{3,}/g) || []).length < 20) throw new Error("Could not read text from this file (scanned or unusual PDF?). Paste the text of your CV instead.");
  return text.slice(0, 40000);
}
