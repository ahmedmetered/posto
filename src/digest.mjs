// The daily digest: what is new and good, what needs attention. Built from the database, delivered in the app
// and, if the user sets a webhook, pushed to their phone (ntfy.sh, Discord, Slack or any URL that accepts a POST).
import { now } from "./db.mjs";

export function buildDigest(db, userId, since) {
  const fresh = db.prepare(`SELECT j.company, j.title, j.location, j.url, uj.score, uj.cv FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id
    WHERE uj.user_id = ? AND uj.state = 'new' AND uj.verdict = 'fit' AND uj.created_at >= ? ORDER BY uj.score DESC LIMIT 8`).all(userId, since);
  const newCount = db.prepare("SELECT COUNT(*) n FROM user_jobs WHERE user_id = ? AND state = 'new' AND verdict = 'fit' AND created_at >= ?").get(userId, since).n;
  const waiting = db.prepare("SELECT COUNT(*) n FROM user_jobs WHERE user_id = ? AND state = 'new' AND verdict = 'fit'").get(userId).n;
  const unread = db.prepare("SELECT company, role, status FROM applications WHERE user_id = ? AND unread > 0 ORDER BY updated DESC LIMIT 10").all(userId);
  const interviews = db.prepare("SELECT COUNT(*) n FROM applications WHERE user_id = ? AND status = 'Interviewing'").get(userId).n;
  const lines = [];
  if (newCount) lines.push(`${newCount} new job${newCount > 1 ? "s" : ""} that fit you:`, ...fresh.map(j => `- ${j.title} at ${j.company}${j.location ? " (" + j.location + ")" : ""}${j.cv ? " [CV: " + j.cv + "]" : ""}\n  ${j.url}`));
  else lines.push(waiting ? `No new matches today. ${waiting} still waiting in your feed.` : "No new matches today.");
  if (unread.length) lines.push("", `${unread.length} application${unread.length > 1 ? "s" : ""} with new replies:`, ...unread.map(a => `- ${a.company}, ${a.role}: ${a.status}`));
  if (interviews) lines.push("", `${interviews} interview${interviews > 1 ? "s" : ""} in progress.`);
  return { at: now(), newCount, waiting, unread: unread.length, interviews, items: fresh, text: lines.join("\n") };
}

export async function sendWebhook(url, title, text, fetchImpl = fetch) {
  let u; try { u = new URL(url); } catch { throw new Error("The notification address is not a valid URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("The notification address must start with http:// or https://");
  let init;
  if (/discord(app)?\.com$/.test(u.hostname)) init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${text}`.slice(0, 1900) }) };
  else if (/slack\.com$/.test(u.hostname)) init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*${title}*\n${text}` }) };
  else init = { headers: { "content-type": "text/plain; charset=utf-8", title: title.replace(/[^\x20-\x7e]/g, "").slice(0, 200) || "Job digest" }, body: text }; // ntfy and generic receivers
  const r = await fetchImpl(u, { method: "POST", signal: AbortSignal.timeout(15000), ...init });
  if (!r.ok) throw new Error(`The notification service answered ${r.status}.`);
}
