// HTTP server: JSON API under /api, static pages from /public. Standard library only.
// Run: node src/server.mjs   (PORT, DB_FILE, SECURE_COOKIES=1 behind https)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, now } from "./db.mjs";
import * as auth from "./auth.mjs";
import { normalizeProfile, defaultProfile, describeProfile } from "./profile.mjs";
import { evaluate } from "./eligibility.mjs";
import { matchUser, seedBoards, disabledFeeds, feedNames } from "./sweep.mjs";
import { ADAPTERS } from "./sources/index.mjs";
import { rankCvs, textFromUpload } from "./cv.mjs";
import { tailor, aiConfigFromInput, AI_PROVIDERS, TAILOR_KINDS } from "./ai.mjs";
import { accountConfig, accountFromInput, testLogin, checkMail } from "./mail/check.mjs";
import { PROVIDERS } from "./mail/classify.mjs";
import { encrypt, decrypt } from "./secrets.mjs";
import { sendWebhook } from "./digest.mjs";
import { getSchedule, setSchedule, getSetting, putSetting, sweepAndNotify, startScheduler } from "./scheduler.mjs";
import { countryList } from "./geo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const STATUSES = ["Found", "Ready to send", "Applied", "Replied", "Interviewing", "Offer", "Rejected", "Withdrawn"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const today = () => new Date().toISOString().slice(0, 10);
const cap = (v, n) => String(v ?? "").slice(0, n);

export function createApp(db, { secureCookies = false, aiFetch = fetch } = {}) {
  seedBoards(db);
  const sendJson = (res, status, body, extra = {}) => { const s = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }); res.end(s); };
  const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(auth.httpErr(413, "Request too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(auth.httpErr(400, "Invalid JSON.")); } });
    req.on("error", reject);
  });
  // block cross-site writes: the Origin header, when present, must match the Host
  const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };

  const jobFor = (userId, id) => db.prepare("SELECT j.*, uj.track, uj.cv FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id WHERE uj.user_id = ? AND uj.job_id = ?").get(userId, +id);
  let sweeping = false;

  function aiConfigFor(userId) {
    const raw = getSetting(db, userId, "ai"); if (!raw) return null;
    const cfg = JSON.parse(raw), k = getSetting(db, userId, "ai_key");
    return { ...cfg, apiKey: k ? decrypt(k) : "" };
  }
  function mailState(userId) {
    const r = db.prepare("SELECT * FROM mail_accounts WHERE user_id = ?").get(userId);
    const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { host: v.host, port: v.port, secure: v.secure, help: v.help }]));
    if (!r) return { configured: false, providers };
    return { configured: true, providers, provider: r.provider, user: r.mail_user, host: r.host, port: r.port, secure: !!r.secure, folders: JSON.parse(r.folders_json), skip: JSON.parse(r.skip_json),
      last_check: r.last_check, last_result: r.last_result ? JSON.parse(r.last_result) : null, last_error: r.last_error, review: db.prepare("SELECT COUNT(*) n FROM mail_review WHERE user_id = ?").get(userId).n };
  }
  function settingsState(userId) {
    const ai = getSetting(db, userId, "ai"), hook = getSetting(db, userId, "webhook"), last = db.prepare("SELECT v FROM kv WHERE k = 'last_sweep'").get();
    return { schedule: getSchedule(db), webhook: hook || "", ai: ai ? { ...JSON.parse(ai), hasKey: !!getSetting(db, userId, "ai_key") } : null, aiProviders: AI_PROVIDERS,
      feeds: feedNames(), feedsOff: disabledFeeds(db), boards: db.prepare("SELECT id, ats, slug FROM boards ORDER BY ats, slug").all(), atsList: Object.keys(ADAPTERS),
      lastSweep: last ? JSON.parse(last.v) : null, sweeping, hasToken: !!getSetting(db, userId, "api_token") };
  }

  const appRow = r => r && ({ ...r, top: !!r.top, easy: !!r.easy });
  const ownApp = (userId, id) => db.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?").get(Number(id), userId);

  function feed(userId, q) {
    const v = q.get("verdict"), st = q.get("state") || "new";
    const where = ["uj.user_id = ?"], args = [userId];
    if (st !== "all") { where.push("uj.state = ?"); args.push(st); }
    if (v === "fit" || v === "check") { where.push("uj.verdict = ?"); args.push(v); }
    const limit = Math.min(Math.max(+q.get("limit") || 40, 1), 100), offset = Math.max(+q.get("offset") || 0, 0);
    const rows = db.prepare(`SELECT uj.job_id AS id, uj.verdict, uj.score, uj.reasons_json, uj.track, uj.cv, uj.state, j.company, j.title, j.location, j.url, j.source, j.posted_at, j.first_seen, j.salary_json
      FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id WHERE ${where.join(" AND ")} ORDER BY (uj.verdict = 'fit') DESC, uj.score DESC, COALESCE(j.posted_at, j.first_seen) DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) n FROM user_jobs uj WHERE ${where.join(" AND ")}`).get(...args).n;
    const ms = total === 0 ? getSetting(db, userId, "match_stats") : null;
    return { total, explain: ms ? JSON.parse(ms) : null, jobs: rows.map(r => ({ id: r.id, verdict: r.verdict, score: r.score, reasons: JSON.parse(r.reasons_json), track: r.track, cv: r.cv, state: r.state, company: r.company, title: r.title, location: r.location, url: r.url, source: r.source, posted_at: r.posted_at || r.first_seen, salary: r.salary_json ? JSON.parse(r.salary_json) : null })) };
  }

  function insights(userId) {
    const apps = db.prepare("SELECT * FROM applications WHERE user_id = ?").all(userId);
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0])); apps.forEach(a => { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });
    const sent = apps.filter(a => ["Applied", "Replied", "Interviewing", "Offer", "Rejected"].includes(a.status));
    const answered = sent.filter(a => ["Replied", "Interviewing", "Offer", "Rejected"].includes(a.status));
    const byCv = {}; for (const a of sent) { const k = a.cv || "(no CV set)"; (byCv[k] ||= { sent: 0, answered: 0, interviews: 0 }); byCv[k].sent++; if (["Replied", "Interviewing", "Offer", "Rejected"].includes(a.status)) byCv[k].answered++; if (["Interviewing", "Offer"].includes(a.status)) byCv[k].interviews++; }
    const gaps = db.prepare(`SELECT a.date_applied d, MIN(m.ts) t FROM applications a JOIN messages m ON m.application_id = a.id AND m.dir = 'in' WHERE a.user_id = ? AND a.date_applied != '' GROUP BY a.id`).all(userId)
      .map(r => (Date.parse(r.t) - Date.parse(r.d)) / 864e5).filter(x => x >= 0).sort((a, b) => a - b);
    const feedCounts = db.prepare("SELECT verdict, COUNT(*) n FROM user_jobs WHERE user_id = ? AND state = 'new' GROUP BY verdict").all(userId);
    return { total: apps.length, byStatus, sent: sent.length, answered: answered.length, responseRate: sent.length ? Math.round(100 * answered.length / sent.length) : null,
      medianDaysToReply: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10 : null, byCv, newFit: feedCounts.find(f => f.verdict === "fit")?.n || 0, newCheck: feedCounts.find(f => f.verdict === "check")?.n || 0 };
  }

  // ---- browser extension: a personal access token instead of a cookie, and only these three routes
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const tokenHash = t => crypto.createHash("sha256").update(t).digest("hex");
  async function extensionApi(req, res, p, method, token) {
    const row = db.prepare("SELECT u.id, u.email FROM settings s JOIN users u ON u.id = s.user_id WHERE s.k = 'api_token' AND s.v = ?").get(tokenHash(token));
    const send = (status, body) => sendJson(res, status, body, CORS);
    if (!row) return send(401, { error: "This token is not valid. Create a new one in Settings." });
    if (p === "/api/ext/ping" && method === "GET") return send(200, { ok: true, email: row.email });
    if ((p === "/api/ext/check" || p === "/api/ext/import") && method === "POST") {
      const b = await readBody(req, 2e6);
      const title = cap(b.title, 200).trim(), company = cap(b.company, 160).trim(), url = /^https?:\/\//i.test(b.url || "") ? cap(b.url, 600) : "";
      if (!title) return send(400, { error: "No job title found on this page." });
      const job = { title, company, location: cap(b.location, 200), description: cap(b.description, 6000), remote: /remote|work from home|telework/i.test(`${b.location} ${title}`) ? true : null };
      const prow = db.prepare("SELECT json FROM profiles WHERE user_id = ?").get(row.id);
      const result = prow ? evaluate(job, normalizeProfile(JSON.parse(prow.json))) : null;
      const dup = db.prepare("SELECT id FROM applications WHERE user_id = ? AND ((url != '' AND url = ?) OR (lower(company) = lower(?) AND lower(role) = lower(?)))").get(row.id, url, company, title);
      if (p === "/api/ext/check") return send(200, { result, existing: dup ? dup.id : null, hasProfile: !!prow });
      if (dup) return send(200, { id: dup.id, existing: true, result });
      const t = now(), cv = result?.track?.cv || "", easy = b.easy ? 1 : 0;
      const id = db.prepare("INSERT INTO applications (user_id, company, role, url, status, cv, location, easy, notes, added, updated) VALUES (?, ?, ?, ?, 'Found', ?, ?, ?, ?, ?, ?)")
        .run(row.id, company || "(unknown)", title, url, cv, cap(b.location, 120), easy, cap(b.source ? `Saved from ${b.source}` : "", 200), t, t).lastInsertRowid;
      return send(201, { id: Number(id), existing: false, result });
    }
    return send(404, { error: "Not found." });
  }

  async function api(req, res, url) {
    const method = req.method, p = url.pathname.replace(/\/+$/, "") || "/";
    if (p.startsWith("/api/ext/")) { // token-authenticated, so the cookie-based cross-site check below does not apply
      if (method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
      const bt = (req.headers.authorization || "").match(/^Bearer (jst_[A-Za-z0-9_-]{20,})$/);
      if (!bt) return sendJson(res, 401, { error: "Missing token." }, CORS);
      return extensionApi(req, res, p, method, bt[1]);
    }
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) throw auth.httpErr(403, "Cross-site request blocked.");
    const cookies = auth.parseCookies(req.headers.cookie), token = cookies.sid;
    const body = (method === "GET" || method === "HEAD" || method === "DELETE") ? {} : await readBody(req, url.pathname.startsWith("/api/cvs") ? 6e6 : 1e6);
    const setSession = userId => { const s = auth.createSession(db, userId); return { "set-cookie": auth.cookie(s.token, s.maxAge, secureCookies) }; };

    if (p === "/api/signup" && method === "POST") { const id = auth.signup(db, body.email, body.password); return sendJson(res, 201, { ok: true }, setSession(id)); }
    if (p === "/api/login" && method === "POST") { const id = auth.login(db, body.email, body.password); return sendJson(res, 200, { ok: true }, setSession(id)); }
    if (p === "/api/logout" && method === "POST") { auth.destroySession(db, token); return sendJson(res, 200, { ok: true }, { "set-cookie": auth.cookie("", 0, secureCookies) }); }

    if (p === "/api/meta" && method === "GET") return sendJson(res, 200, { countries: countryList(), statuses: STATUSES });
    const user = auth.userFromToken(db, token);
    if (!user) throw auth.httpErr(401, "Sign in first.");
    let m;

    if (p === "/api/me" && method === "GET") {
      const row = db.prepare("SELECT json FROM profiles WHERE user_id = ?").get(user.id);
      const profile = row ? normalizeProfile(JSON.parse(row.json)) : null;
      return sendJson(res, 200, { user, profile, defaults: defaultProfile(), described: profile ? describeProfile(profile) : null, ai: !!getSetting(db, user.id, "ai") });
    }
    if (p === "/api/profile" && method === "PUT") {
      const profile = normalizeProfile(body);
      if (!profile.home_country) throw auth.httpErr(400, "Say which country you live in (two letters, for example IT).");
      db.prepare("INSERT INTO profiles (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(user.id, JSON.stringify(profile), now());
      const stats = matchUser(db, user.id);
      return sendJson(res, 200, { profile, described: describeProfile(profile), stats });
    }
    if (p === "/api/rematch" && method === "POST") return sendJson(res, 200, { stats: matchUser(db, user.id) });
    if (p === "/api/feed" && method === "GET") return sendJson(res, 200, feed(user.id, url.searchParams));
    if ((m = p.match(/^\/api\/feed\/(\d+)\/state$/)) && method === "POST") {
      if (!["new", "saved", "dismissed"].includes(body.state)) throw auth.httpErr(400, "Unknown state.");
      db.prepare("UPDATE user_jobs SET state = ? WHERE user_id = ? AND job_id = ?").run(body.state, user.id, +m[1]);
      return sendJson(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/feed\/(\d+)\/track$/)) && method === "POST") {
      const r = db.prepare("SELECT j.*, uj.cv FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id WHERE uj.user_id = ? AND uj.job_id = ?").get(user.id, +m[1]);
      if (!r) throw auth.httpErr(404, "Job not found.");
      const dup = db.prepare("SELECT id FROM applications WHERE user_id = ? AND job_id = ?").get(user.id, r.id);
      if (dup) return sendJson(res, 200, { id: dup.id, existing: true });
      const sal = r.salary_json ? JSON.parse(r.salary_json) : null, t = now();
      const id = db.prepare(`INSERT INTO applications (user_id, job_id, company, role, url, status, cv, location, salary, added, updated) VALUES (?, ?, ?, ?, ?, 'Found', ?, ?, ?, ?, ?)`)
        .run(user.id, r.id, r.company, r.title, r.url, r.cv || "", r.location, sal ? `${sal.min ?? ""}-${sal.max ?? ""} ${sal.currency || ""}/${sal.period || "year"}` : "", t, t).lastInsertRowid;
      db.prepare("UPDATE user_jobs SET state = 'saved' WHERE user_id = ? AND job_id = ?").run(user.id, r.id);
      return sendJson(res, 201, { id: Number(id) });
    }

    if (p === "/api/applications" && method === "GET") {
      const rows = db.prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY updated DESC").all(user.id).map(appRow);
      const msgs = db.prepare("SELECT m.* FROM messages m JOIN applications a ON a.id = m.application_id WHERE a.user_id = ? ORDER BY m.ts").all(user.id);
      const by = {}; msgs.forEach(x => (by[x.application_id] ||= []).push({ id: x.ext_id, dir: x.dir, platform: x.platform, text: x.text, ts: x.ts }));
      return sendJson(res, 200, { statuses: STATUSES, applications: rows.map(a => ({ ...a, messages: by[a.id] || [] })) });
    }
    if (p === "/api/applications" && method === "POST") {
      if (!body.company || !body.role) throw auth.httpErr(400, "Company and role are required.");
      const t = now(), status = STATUSES.includes(body.status) ? body.status : "Found";
      const id = db.prepare(`INSERT INTO applications (user_id, company, role, url, status, cv, notes, salary, location, top, easy, date_applied, added, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, cap(body.company, 120), cap(body.role, 160), cap(/^https?:\/\//i.test(body.url || "") ? body.url : "", 600), status, cap(body.cv, 80), cap(body.notes, 4000), cap(body.salary, 80), cap(body.location, 120), body.top ? 1 : 0, body.easy ? 1 : 0, status === "Applied" ? today() : "", t, t).lastInsertRowid;
      return sendJson(res, 201, { id: Number(id) });
    }
    if ((m = p.match(/^\/api\/applications\/(\d+)$/))) {
      const a = ownApp(user.id, m[1]); if (!a) throw auth.httpErr(404, "Not found.");
      if (method === "PATCH") {
        const set = [], args = [];
        const text = { company: 120, role: 160, cv: 80, notes: 4000, salary: 80, location: 120 };
        for (const [k, n] of Object.entries(text)) if (k in body) { set.push(`${k} = ?`); args.push(cap(body[k], n)); }
        if ("url" in body) { set.push("url = ?"); args.push(/^https?:\/\//i.test(body.url || "") ? cap(body.url, 600) : ""); }
        for (const k of ["top", "easy"]) if (k in body) { set.push(`${k} = ?`); args.push(body[k] ? 1 : 0); }
        if ("status" in body) {
          if (!STATUSES.includes(body.status)) throw auth.httpErr(400, "Unknown status.");
          set.push("status = ?"); args.push(body.status);
          if (body.status === "Applied" && !a.date_applied) { set.push("date_applied = ?"); args.push(today()); }
        }
        if ("unread" in body) { set.push("unread = ?"); args.push(Math.max(0, Math.min(999, +body.unread || 0))); }
        if (set.length) db.prepare(`UPDATE applications SET ${set.join(", ")}, updated = ? WHERE id = ?`).run(...args, now(), a.id);
        return sendJson(res, 200, appRow(ownApp(user.id, a.id)));
      }
      if (method === "DELETE") { db.prepare("DELETE FROM applications WHERE id = ?").run(a.id); return sendJson(res, 200, { ok: true }); }
    }
    if ((m = p.match(/^\/api\/applications\/(\d+)\/messages$/)) && method === "POST") {
      const a = ownApp(user.id, m[1]); if (!a) throw auth.httpErr(404, "Not found.");
      let added = 0, inbound = 0;
      const ins = db.prepare("INSERT OR IGNORE INTO messages (application_id, ext_id, dir, platform, text, ts) VALUES (?, ?, ?, ?, ?, ?)");
      for (const x of (Array.isArray(body.messages) ? body.messages : []).slice(0, 40)) {
        if (!x || !x.id || !x.text) continue;
        const dir = x.dir === "out" ? "out" : "in", ts = Number.isNaN(Date.parse(x.ts)) ? now() : new Date(x.ts).toISOString();
        if (ins.run(a.id, cap(x.id, 200), dir, cap(x.platform || "email", 20), cap(x.text, 4000), ts).changes) { added++; if (dir === "in") inbound++; }
      }
      if (added) db.prepare("UPDATE applications SET unread = unread + ?, updated = ? WHERE id = ?").run(inbound, now(), a.id);
      return sendJson(res, 200, { added });
    }
    // ---- one job in full (for the detail panel) and how well each of the user's CVs covers it
    if ((m = p.match(/^\/api\/feed\/(\d+)$/)) && method === "GET") {
      const r = jobFor(user.id, m[1]); if (!r) throw auth.httpErr(404, "Job not found.");
      return sendJson(res, 200, { id: r.id, company: r.company, title: r.title, location: r.location, url: r.url, source: r.source, description: r.description, track: r.track, cv: r.cv });
    }
    if ((m = p.match(/^\/api\/feed\/(\d+)\/cv-fit$/)) && method === "GET") {
      const r = jobFor(user.id, m[1]); if (!r) throw auth.httpErr(404, "Job not found.");
      const cvs = db.prepare("SELECT name, text FROM cvs WHERE user_id = ? AND text != ''").all(user.id);
      return sendJson(res, 200, { ranked: rankCvs(cvs, r, r.cv), hasCvs: cvs.length > 0 });
    }
    if ((m = p.match(/^\/api\/feed\/(\d+)\/tailor$/)) && method === "POST") {
      const r = jobFor(user.id, m[1]); if (!r) throw auth.httpErr(404, "Job not found.");
      if (!TAILOR_KINDS.includes(body.kind)) throw auth.httpErr(400, "Unknown kind.");
      const cv = db.prepare("SELECT text FROM cvs WHERE user_id = ? AND name = ?").get(user.id, String(body.cv || ""));
      if (!cv || !cv.text) throw auth.httpErr(400, "Pick one of your saved CVs first.");
      const cfg = aiConfigFor(user.id); if (!cfg) throw auth.httpErr(400, "Set up an AI provider in Settings first (a local Ollama model needs no key).");
      try { return sendJson(res, 200, { text: await tailor(cfg, body.kind, { cv: cv.text, job: r }, aiFetch) }); }
      catch (e) { throw auth.httpErr(502, e.message); }
    }

    // ---- CVs
    if (p === "/api/cvs" && method === "GET") {
      const rows = db.prepare("SELECT id, name, filename, length(text) AS chars, updated_at, substr(text, 1, 240) AS preview FROM cvs WHERE user_id = ? ORDER BY name").all(user.id);
      return sendJson(res, 200, { cvs: rows });
    }
    if (p === "/api/cvs" && method === "PUT") {
      const name = cap(body.name, 80).trim(); if (!name) throw auth.httpErr(400, "Give the CV a name, for example \"Product EN\".");
      let text = cap(body.text, 40000), filename = cap(body.filename, 200);
      if (body.data) {
        try { text = textFromUpload(filename, Buffer.from(String(body.data), "base64")); } catch (e) { throw auth.httpErr(400, e.message); }
      }
      if (text.trim().length < 20) throw auth.httpErr(400, "The CV is empty. Paste its text or upload a file.");
      const t = now();
      db.prepare("INSERT INTO cvs (user_id, name, text, filename, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET text = excluded.text, filename = excluded.filename, updated_at = excluded.updated_at")
        .run(user.id, name, text, filename, t, t);
      return sendJson(res, 200, { ok: true, chars: text.length });
    }
    if ((m = p.match(/^\/api\/cvs\/(\d+)$/))) {
      const row = db.prepare("SELECT * FROM cvs WHERE id = ? AND user_id = ?").get(+m[1], user.id); if (!row) throw auth.httpErr(404, "Not found.");
      if (method === "GET") return sendJson(res, 200, { id: row.id, name: row.name, filename: row.filename, text: row.text });
      if (method === "DELETE") { db.prepare("DELETE FROM cvs WHERE id = ?").run(row.id); return sendJson(res, 200, { ok: true }); }
    }

    // ---- mailbox connection and checks
    if (p === "/api/mail" && method === "GET") return sendJson(res, 200, mailState(user.id));
    if (p === "/api/mail" && method === "PUT") {
      const prev = db.prepare("SELECT pass_enc FROM mail_accounts WHERE user_id = ?").get(user.id);
      const a = accountFromInput(body, encrypt);
      const pass = a.pass || prev?.pass_enc; if (!pass) throw auth.httpErr(400, "Enter the app password.");
      db.prepare(`INSERT INTO mail_accounts (user_id, provider, mail_user, pass_enc, host, port, secure, folders_json, skip_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, mail_user = excluded.mail_user, pass_enc = excluded.pass_enc, host = excluded.host, port = excluded.port, secure = excluded.secure, folders_json = excluded.folders_json, skip_json = excluded.skip_json, last_error = NULL`)
        .run(user.id, a.provider, a.mail_user, pass, a.host, a.port, a.secure, JSON.stringify(a.folders), JSON.stringify(a.skip));
      return sendJson(res, 200, mailState(user.id));
    }
    if (p === "/api/mail" && method === "DELETE") { db.prepare("DELETE FROM mail_accounts WHERE user_id = ?").run(user.id); db.prepare("DELETE FROM mail_review WHERE user_id = ?").run(user.id); return sendJson(res, 200, { ok: true }); }
    if (p === "/api/mail/test" && method === "POST") {
      const row = db.prepare("SELECT * FROM mail_accounts WHERE user_id = ?").get(user.id); if (!row) throw auth.httpErr(400, "Save the mailbox settings first.");
      try { return sendJson(res, 200, { ok: true, folders: await testLogin(accountConfig(row)) }); } catch (e) { throw auth.httpErr(502, e.message); }
    }
    if (p === "/api/mail/check" && method === "POST") {
      const days = Math.min(Math.max(+body.days || 3, 1), 120);
      const r = await checkMail(db, user.id, { days, dryRun: !!body.dryRun });
      if (!r.configured) throw auth.httpErr(400, "Connect a mailbox first.");
      if (r.error) throw auth.httpErr(502, r.error);
      return sendJson(res, 200, r);
    }
    if (p === "/api/mail/review" && method === "GET") return sendJson(res, 200, { items: db.prepare("SELECT id, date, sender, subject, kind, match, hint FROM mail_review WHERE user_id = ? ORDER BY id DESC LIMIT 100").all(user.id) });
    if (p === "/api/mail/review" && method === "DELETE") { db.prepare("DELETE FROM mail_review WHERE user_id = ?").run(user.id); return sendJson(res, 200, { ok: true }); }

    // ---- settings: schedule, notifications, AI, sources
    if (p === "/api/settings" && method === "GET") return sendJson(res, 200, settingsState(user.id));
    if (p === "/api/settings" && method === "PUT") {
      if (body.schedule) setSchedule(db, body.schedule);
      if ("webhook" in body) {
        const w = cap(body.webhook, 400).trim();
        if (w && !/^https?:\/\//i.test(w)) throw auth.httpErr(400, "The notification address must start with http:// or https://");
        putSetting(db, user.id, "webhook", w);
      }
      if ("ai" in body) {
        if (!body.ai || !body.ai.provider) { putSetting(db, user.id, "ai", null); putSetting(db, user.id, "ai_key", null); }
        else {
          const cfg = aiConfigFromInput(body.ai); if (!cfg) throw auth.httpErr(400, "Unknown AI provider.");
          putSetting(db, user.id, "ai", JSON.stringify(cfg));
          if (body.ai.apiKey) putSetting(db, user.id, "ai_key", encrypt(String(body.ai.apiKey).trim()));
        }
      }
      if (Array.isArray(body.feedsOff)) db.prepare("INSERT INTO kv (k, v) VALUES ('feeds_off', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(body.feedsOff.filter(f => feedNames().includes(f))));
      return sendJson(res, 200, settingsState(user.id));
    }
    if (p === "/api/settings/webhook-test" && method === "POST") {
      const hook = getSetting(db, user.id, "webhook"); if (!hook) throw auth.httpErr(400, "Save a notification address first.");
      try { await sendWebhook(hook, "Job digest test", "This is a test from your job search app.", aiFetch); return sendJson(res, 200, { ok: true }); } catch (e) { throw auth.httpErr(502, e.message); }
    }
    if (p === "/api/boards" && method === "POST") {
      const ats = String(body.ats || ""), slug = cap(body.slug, 80).trim().toLowerCase();
      if (!ADAPTERS[ats]) throw auth.httpErr(400, "Pick a supported system: " + Object.keys(ADAPTERS).join(", "));
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) throw auth.httpErr(400, "The company name in the careers URL can only have letters, numbers, dots and dashes.");
      try { const jobs = await ADAPTERS[ats](slug); db.prepare("INSERT OR IGNORE INTO boards (ats, slug) VALUES (?, ?)").run(ats, slug); return sendJson(res, 201, { ok: true, postings: jobs.length }); }
      catch (e) { throw auth.httpErr(400, `Could not read ${ats}/${slug}: ${e.message}. Check the careers page URL.`); }
    }
    if ((m = p.match(/^\/api\/boards\/(\d+)$/)) && method === "DELETE") { db.prepare("DELETE FROM boards WHERE id = ?").run(+m[1]); return sendJson(res, 200, { ok: true }); }
    if (p === "/api/sweep" && method === "POST") {
      if (sweeping) throw auth.httpErr(409, "A sweep is already running.");
      sweeping = true;
      try { const r = await sweepAndNotify(db, { fetchSources: body.fetch !== false, fetchImpl: aiFetch }); return sendJson(res, 200, { added: r.added, counts: r.counts, errors: r.errors, per: r.per.filter(x => x.user === user.email) }); }
      finally { sweeping = false; }
    }
    if (p === "/api/token" && method === "POST") {
      const token = "jst_" + crypto.randomBytes(24).toString("base64url");
      putSetting(db, user.id, "api_token", tokenHash(token));
      return sendJson(res, 200, { token });
    }
    if (p === "/api/token" && method === "DELETE") { putSetting(db, user.id, "api_token", null); return sendJson(res, 200, { ok: true }); }
    if (p === "/api/digest" && method === "GET") { const r = getSetting(db, user.id, "last_digest"); return sendJson(res, 200, { digest: r ? JSON.parse(r) : null }); }

    if (p === "/api/insights" && method === "GET") return sendJson(res, 200, insights(user.id));
    if (p === "/api/export" && method === "GET") {
      const out = { exported_at: now(), user, profile: db.prepare("SELECT json FROM profiles WHERE user_id = ?").get(user.id)?.json ? JSON.parse(db.prepare("SELECT json FROM profiles WHERE user_id = ?").get(user.id).json) : null,
        applications: db.prepare("SELECT * FROM applications WHERE user_id = ?").all(user.id), cvs: db.prepare("SELECT name, filename, text FROM cvs WHERE user_id = ?").all(user.id), messages: db.prepare("SELECT m.* FROM messages m JOIN applications a ON a.id = m.application_id WHERE a.user_id = ?").all(user.id) };
      return sendJson(res, 200, out, { "content-disposition": 'attachment; filename="my-data.json"' });
    }
    if (p === "/api/account/delete" && method === "POST") {
      const row = db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(user.id);
      if (!auth.verifyPassword(String(body.password || ""), row.pass_hash)) throw auth.httpErr(403, "Wrong password.");
      auth.deleteAccount(db, user.id);
      return sendJson(res, 200, { ok: true }, { "set-cookie": auth.cookie("", 0, secureCookies) });
    }
    throw auth.httpErr(404, "Not found.");
  }

  return async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw auth.httpErr(405, "Method not allowed.");
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw auth.httpErr(404, "Not found.");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
      res.end(fs.readFileSync(file));
    } catch (e) {
      const status = e.status || 500; if (status === 500) console.error(e);
      sendJson(res, status, { error: status === 500 ? "Something went wrong." : e.message });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = openDb(process.env.DB_FILE || path.resolve("data/app.db")), port = +process.env.PORT || 7678;
  http.createServer(createApp(db, { secureCookies: process.env.SECURE_COOKIES === "1" })).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}`));
  if (process.env.NO_SCHEDULER !== "1") startScheduler(db);
}
