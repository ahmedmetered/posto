// Runs the daily sweep and the mailbox checks while the server is up, so nothing needs cron or Task Scheduler.
// If the computer was asleep at the scheduled hour, the sweep runs as soon as the server sees it is overdue.
import { runSweep } from "./sweep.mjs";
import { checkMail } from "./mail/check.mjs";
import { buildDigest, sendWebhook } from "./digest.mjs";

export const DEFAULT_SCHEDULE = { enabled: true, hour: 8, mailEveryMinutes: 30 };

export function getSchedule(db) {
  const r = db.prepare("SELECT v FROM kv WHERE k = 'schedule'").get();
  let s = {}; try { s = r ? JSON.parse(r.v) : {}; } catch { /* use defaults */ }
  const num = (v, def, lo, hi) => (Number.isFinite(+v) && v !== "" && v != null ? Math.min(hi, Math.max(lo, Math.floor(+v))) : def);
  return { enabled: s.enabled !== false, hour: num(s.hour, 8, 0, 23), mailEveryMinutes: num(s.mailEveryMinutes, 30, 5, 1440) };
}
export function setSchedule(db, input) {
  const cur = getSchedule(db), next = { enabled: input.enabled ?? cur.enabled, hour: input.hour ?? cur.hour, mailEveryMinutes: input.mailEveryMinutes ?? cur.mailEveryMinutes };
  db.prepare("INSERT INTO kv (k, v) VALUES ('schedule', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(next));
  return getSchedule(db);
}

export const getSetting = (db, userId, k) => db.prepare("SELECT v FROM settings WHERE user_id = ? AND k = ?").get(userId, k)?.v ?? null;
export const putSetting = (db, userId, k, v) => v == null || v === ""
  ? db.prepare("DELETE FROM settings WHERE user_id = ? AND k = ?").run(userId, k)
  : db.prepare("INSERT INTO settings (user_id, k, v) VALUES (?, ?, ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v").run(userId, k, String(v));

// one full cycle: sweep, then a digest for each user. Exported so the "Run now" button and the tests use the same code.
export async function sweepAndNotify(db, { log = () => {}, fetchSources = true, fetchImpl = fetch } = {}) {
  const lastRow = db.prepare("SELECT v FROM kv WHERE k = 'last_sweep'").get();
  const since = lastRow ? JSON.parse(lastRow.v).at : new Date(Date.now() - 864e5).toISOString();
  const result = await runSweep(db, { fetch: fetchSources, log });
  for (const u of db.prepare("SELECT id FROM users").all()) {
    const d = buildDigest(db, u.id, since);
    db.prepare("INSERT INTO settings (user_id, k, v) VALUES (?, 'last_digest', ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v").run(u.id, JSON.stringify(d));
    const hook = getSetting(db, u.id, "webhook");
    if (hook && (d.newCount || d.unread)) { try { await sendWebhook(hook, `Job digest: ${d.newCount} new`, d.text, fetchImpl); } catch (e) { log(`  digest for user ${u.id}: ${e.message}`); } }
  }
  return result;
}

export function startScheduler(db, { log = console.log } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const s = getSchedule(db);
      if (s.enabled) {
        const last = db.prepare("SELECT v FROM kv WHERE k = 'last_sweep'").get(), lastAt = last ? new Date(JSON.parse(last.v).at) : null, d = new Date();
        const dueToday = d.getHours() >= s.hour && (!lastAt || lastAt.toDateString() !== d.toDateString());
        if (dueToday && db.prepare("SELECT COUNT(*) n FROM users").get().n) { log("scheduler: daily sweep"); await sweepAndNotify(db, { log }); }
      }
      for (const m of db.prepare("SELECT user_id, last_check FROM mail_accounts").all()) {
        if (m.last_check && Date.now() - new Date(m.last_check).getTime() < s.mailEveryMinutes * 60000) continue;
        const r = await checkMail(db, m.user_id, { days: 3, log });
        if (r.error) log(`scheduler: mail for user ${m.user_id}: ${r.error}`); else if (r.applied?.length) log(`scheduler: mail updated ${r.applied.join("; ")}`);
      }
    } catch (e) { log("scheduler error: " + e.message); } finally { busy = false; }
  };
  const timer = setInterval(tick, 60000); timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  return () => clearInterval(timer);
}
