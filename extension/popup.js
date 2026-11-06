// The Posto side panel. It stays open while you browse; when the page or tab changes it goes back to
// "Check this page" and reads nothing until you press the button.
import { extractJob } from "./extract.mjs";

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const READ = { origins: ["https://*/*", "http://*/*"] };
let cfg = { server: "http://localhost:7678", token: "" }, job = null;

async function call(path, body) {
  const r = await fetch(cfg.server.replace(/\/+$/, "") + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + cfg.token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Posto answered " + r.status);
  return j;
}
function show(result, existing) {
  const out = $("out"); out.replaceChildren();
  if (existing) out.append(el("p", "muted", "Already in your tracker."));
  if (!result) { out.append(el("p", "muted", "Fill in My situation in Posto to see whether this job fits you.")); return; }
  const word = { fit: "Fits you", check: "Check first", no: "Not for you" }[result.verdict];
  const badge = el("div"); badge.style.margin = "8px 0"; badge.append(el("span", "verdict " + result.verdict, `${word} · ${result.score}`));
  out.append(badge);
  for (const r of result.reasons) out.append(el("div", "reason " + r.kind, r.text));
  if (result.track?.cv) out.append(el("p", "muted", "Suggested CV: " + result.track.cv));
}
function idle(note) {
  job = null; $("out").replaceChildren(); $("save").hidden = true; $("err").textContent = "";
  $("title").textContent = "Open a job posting"; $("where").textContent = note || "Then press Check this page. Posto reads a page only when you press the button.";
  $("checkbtn").hidden = !cfg.token; $("checkbtn").disabled = false;
}

async function check() {
  $("err").textContent = ""; $("checkbtn").disabled = true;
  try {
    if (!(await chrome.permissions.contains(READ)) && !(await chrome.permissions.request(READ))) { $("err").textContent = "Posto needs your permission to read the page you check."; return; }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !/^https?:/.test(tab.url || "")) { $("title").textContent = "This page cannot be read"; $("where").textContent = "Open a job posting on a normal website tab."; return; }
    const [{ result: html }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.outerHTML });
    job = extractJob(html, tab.url);
    if (!job.title) { $("title").textContent = "No job found on this page"; $("where").textContent = "Open a job posting and press Check this page again."; return; }
    $("title").textContent = job.title; $("where").textContent = [job.company, job.location, job.source].filter(Boolean).join(" · ");
    const c = await call("/api/ext/check", job); show(c.result, c.existing);
    $("save").hidden = !!c.existing; $("save").disabled = false; $("save").textContent = "Save to my tracker";
  } catch (e) { $("err").textContent = e.message + " (is Posto running?)"; }
  finally { $("checkbtn").disabled = false; }
}

async function main() {
  const saved = await chrome.storage.local.get(["server", "token"]);
  cfg = { server: saved.server || cfg.server, token: saved.token || "" };
  $("server").value = cfg.server; $("token").value = cfg.token;
  $("cfgbtn").onclick = () => { $("cfg").hidden = !$("cfg").hidden; };
  $("saveCfg").onclick = async () => { cfg = { server: $("server").value.trim(), token: $("token").value.trim() }; await chrome.storage.local.set(cfg); location.reload(); };
  $("checkbtn").onclick = check;
  $("save").onclick = async () => { $("save").disabled = true; try { const r = await call("/api/ext/import", job); $("save").textContent = "Saved"; show(r.result, false); } catch (e) { $("err").textContent = e.message; $("save").disabled = false; } };
  if (!cfg.token) { $("title").textContent = "Connect Posto first"; $("where").textContent = "Paste your access token below."; $("cfg").hidden = false; return; }
  idle();
  // keep the panel open across tabs and navigation: reset to a fresh "Check this page" instead of reading anything by itself
  chrome.tabs.onActivated.addListener(() => idle("You switched tabs. Press Check this page when a job posting is open."));
  chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (change.status === "loading" && tab.active) idle("The page changed. Press Check this page when the posting has loaded."); });
}
main().catch(e => { $("err").textContent = e.message; });
