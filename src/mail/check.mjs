// Reads one user's mailbox (IMAP, read-only) and updates their applications from the replies.
// imapflow and mailparser are optional dependencies: if they are missing the rest of the app still works.
//
// Strong matches (the sender's domain or the subject names the company) change the status and add the email to the
// application's thread. Everything uncertain goes to the "review" list instead of being applied.
import { now } from "../db.mjs";
import { decrypt } from "../secrets.mjs";
import { classify, matchEmail, decide, bodyOf, cleanBody, detectProvider, PROVIDERS } from "./classify.mjs";

const clip = (s, n) => String(s ?? "").slice(0, n);

export function accountConfig(row) {
  return { provider: row.provider, user: row.mail_user, password: decrypt(row.pass_enc), host: row.host, port: row.port, secure: !!row.secure,
    folders: JSON.parse(row.folders_json || '["INBOX"]'), skip: JSON.parse(row.skip_json || "[]") };
}

// settings a user types in -> the row we store (provider presets fill in host and port)
export function accountFromInput(input, encrypt) {
  const user = clip(input.user, 200).trim(), provider = PROVIDERS[input.provider] ? input.provider : detectProvider(user), preset = PROVIDERS[provider];
  const host = clip(input.host || preset.host, 200).trim();
  if (!user || !user.includes("@")) throw Object.assign(new Error("Enter the full email address."), { status: 400 });
  if (!host) throw Object.assign(new Error("This provider needs an IMAP host."), { status: 400 });
  const list = v => (Array.isArray(v) ? v : String(v || "").split(",")).map(s => clip(s, 80).trim()).filter(Boolean).slice(0, 20);
  return { provider, mail_user: user, host, port: Math.max(1, Math.min(65535, +(input.port || preset.port) || 993)), secure: (input.secure ?? preset.secure) ? 1 : 0,
    folders: list(input.folders).length ? list(input.folders) : ["INBOX"], skip: list(input.skip), pass: input.password ? encrypt(String(input.password).trim()) : null };
}

async function connect(cfg) {
  let ImapFlow;
  try { ({ ImapFlow } = await import("imapflow")); } catch { throw new Error("Email checking needs two optional packages. Run: npm install"); }
  const open = async user => { const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user, pass: cfg.password }, logger: false }); await c.connect(); return c; };
  try { return await open(cfg.user); }
  catch (e) {
    // some providers (iCloud, GMX) accept only the part before the @ as the login
    try { return await open(cfg.user.split("@")[0]); }
    catch { throw new Error(`Login failed on ${cfg.host}: ${e.message}. ${PROVIDERS[cfg.provider]?.help || ""}`.trim()); }
  }
}

export async function testLogin(cfg) {
  const c = await connect(cfg);
  try { return (await c.list()).map(b => b.path); } finally { await c.logout().catch(() => {}); }
}

// Applies the decision for one already-parsed mail to the database. Pure with respect to the network, so it is tested directly.
export function applyMail(db, userId, mail, { skip = [], dryRun = false } = {}) {
  const apps = db.prepare("SELECT id, company, role, status, notes FROM applications WHERE user_id = ?").all(userId);
  const m = { from: mail.from, subject: mail.subject, body: bodyOf(mail), clean: cleanBody(mail), date: (mail.date || new Date()).toISOString().slice(0, 10) };
  const match = matchEmail(m, apps);
  if (match.app && skip.some(s => (match.app.company || "").toLowerCase().includes(s.toLowerCase()))) return { outcome: "ignored" };
  if (match.kind === "none") return { outcome: "ignored" };
  const kind = classify(m.subject, m.body);
  if (kind === "other" && match.kind !== "strong") return { outcome: "ignored" };
  if (match.kind === "strong" && kind !== "other") {
    const next = decide(kind, match.app);
    if (dryRun) return { outcome: "strong", kind, app: match.app, change: next ? `${match.app.status} -> ${next}` : "no change" };
    if (kind !== "ack") { // acknowledgements are noise on a card
      const text = clip(((m.subject ? m.subject + "\n\n" : "") + m.clean.split("\n").filter(l => l.trim() !== (m.subject || "").trim()).join("\n")).replace(/\n{3,}/g, "\n\n").trim(), 1600);
      const ins = db.prepare("INSERT OR IGNORE INTO messages (application_id, ext_id, dir, platform, text, ts) VALUES (?, ?, 'in', 'email', ?, ?)")
        .run(match.app.id, clip(mail.messageId, 200), text, (mail.date || new Date()).toISOString());
      if (ins.changes) db.prepare("UPDATE applications SET unread = unread + 1, updated = ? WHERE id = ?").run(now(), match.app.id);
    }
    if (next) {
      const note = `${match.app.notes ? match.app.notes + " | " : ""}Email ${m.date} (${kind}): ${clip(m.subject, 80)}`;
      db.prepare("UPDATE applications SET status = ?, notes = ?, updated = ?, date_applied = CASE WHEN ? = 'Applied' AND date_applied = '' THEN ? ELSE date_applied END WHERE id = ?")
        .run(next, clip(note, 4000), now(), next, m.date, match.app.id);
    }
    return { outcome: "applied", kind, app: match.app, change: next ? `${match.app.status} -> ${next}` : "no change" };
  }
  const hint = match.app ? `${match.app.company} - ${match.app.role}` : (match.candidates || []).join(" / ");
  if (!dryRun) db.prepare("INSERT INTO mail_review (user_id, date, sender, subject, kind, match, hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(userId, m.date, clip(m.from, 200), clip(m.subject, 200), kind, match.kind, clip(hint, 300), now());
  return { outcome: "review", kind, match: match.kind, hint };
}

export async function checkMail(db, userId, { days = 3, dryRun = false, log = () => {} } = {}) {
  const row = db.prepare("SELECT * FROM mail_accounts WHERE user_id = ?").get(userId);
  if (!row) return { configured: false };
  const cfg = accountConfig(row), me = cfg.user.toLowerCase();
  const result = { configured: true, scanned: 0, applied: [], review: 0, ignored: 0 };
  const stamp = (res, err) => db.prepare("UPDATE mail_accounts SET last_check = ?, last_result = ?, last_error = ? WHERE user_id = ?").run(now(), res ? JSON.stringify(res) : null, err || null, userId);
  let client;
  try {
    client = await connect(cfg);
    const { simpleParser } = await import("mailparser");
    const boxes = [...cfg.folders];
    try { for (const b of await client.list()) if (b.specialUse === "\\Junk" && !boxes.includes(b.path)) boxes.push(b.path); } catch { /* no junk folder */ }
    const since = new Date(Date.now() - days * 864e5);
    const seenRows = new Set(db.prepare("SELECT msg_id FROM mail_seen WHERE user_id = ?").all(userId).map(r => r.msg_id));
    const markSeen = db.prepare("INSERT OR IGNORE INTO mail_seen (user_id, msg_id) VALUES (?, ?)");
    for (const box of boxes) {
      const lock = await client.getMailboxLock(box, { readOnly: true }); // read-only: nothing is flagged, moved or deleted
      try {
        const uids = await client.search({ since }, { uid: true });
        if (!(uids || []).length) continue;
        log(`${box}: reading ${uids.length} messages`);
        for await (const msg of client.fetch(uids, { source: true, uid: true }, { uid: true })) { // one streamed request, not one per message
          if (!msg.source || msg.source.length > 3e6) continue;
          const mail = await simpleParser(msg.source);
          const id = mail.messageId || `${box}:${msg.uid}`;
          if (seenRows.has(id)) continue; seenRows.add(id); result.scanned++;
          if ((mail.from?.value?.[0]?.address || "").toLowerCase() === me) continue;
          mail.messageId = id;
          const r = applyMail(db, userId, { from: mail.from?.text || "", subject: mail.subject || "", text: mail.text || "", html: mail.html || "", date: mail.date, messageId: id }, { skip: cfg.skip, dryRun });
          if (r.outcome === "applied" || r.outcome === "strong") { if (r.change !== "no change") result.applied.push(`${r.app.company}: ${r.change}`); }
          else if (r.outcome === "review") result.review++; else result.ignored++;
          if (!dryRun) markSeen.run(userId, id);
        }
      } finally { lock.release(); }
    }
    await client.logout().catch(() => {});
    if (!dryRun) stamp(result, null);
    return result;
  } catch (e) {
    try { await client?.logout(); } catch { /* ignore */ }
    stamp(null, e.message);
    return { ...result, error: e.message };
  }
}
