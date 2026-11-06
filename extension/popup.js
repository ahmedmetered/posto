import { extractJob } from "./extract.mjs";

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let cfg = { server: "http://localhost:8790", token: "" }, job = null;

async function call(path, body) {
  const r = await fetch(cfg.server.replace(/\/+$/, "") + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + cfg.token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "The app answered " + r.status);
  return j;
}
function show(result, existing) {
  const out = $("out"); out.replaceChildren();
  if (existing) out.append(el("p", "muted", "Already in your tracker."));
  if (!result) { out.append(el("p", "muted", "Set up your situation in the app to see whether this job fits you.")); return; }
  const word = { fit: "Fits you", check: "Check first", no: "Not for you" }[result.verdict];
  const badge = el("div"); badge.style.margin = "8px 0"; badge.append(el("span", "verdict " + result.verdict, `${word} · ${result.score}`));
  out.append(badge);
  for (const r of result.reasons) out.append(el("div", "reason " + r.kind, r.text));
  if (result.track?.cv) out.append(el("p", "muted", "Suggested CV: " + result.track.cv));
}

async function main() {
  const saved = await chrome.storage.local.get(["server", "token"]);
  cfg = { server: saved.server || cfg.server, token: saved.token || "" };
  $("server").value = cfg.server; $("token").value = cfg.token;
  $("cfgbtn").onclick = () => { $("cfg").hidden = !$("cfg").hidden; };
  $("saveCfg").onclick = async () => { cfg = { server: $("server").value.trim(), token: $("token").value.trim() }; await chrome.storage.local.set(cfg); location.reload(); };
  if (!cfg.token) { $("title").textContent = "Connect to your app first"; $("cfg").hidden = false; return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [{ result: html }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.outerHTML });
  job = extractJob(html, tab.url);
  if (!job.title) { $("title").textContent = "No job found on this page"; $("where").textContent = "Open a job posting and click again."; return; }
  $("title").textContent = job.title; $("where").textContent = [job.company, job.location, job.source].filter(Boolean).join(" · ");
  const c = await call("/api/ext/check", job); show(c.result, c.existing);
  if (!c.existing) { $("save").hidden = false; $("save").onclick = async () => { $("save").disabled = true; try { const r = await call("/api/ext/import", job); $("save").textContent = "Saved"; show(r.result, false); } catch (e) { $("err").textContent = e.message; $("save").disabled = false; } }; }
}
main().catch(e => { $("err").textContent = e.message + " (is the app running?)"; });
