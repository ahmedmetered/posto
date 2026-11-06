// Pure mail logic (no network, no dependencies): provider presets, classifying a reply, matching it to an application,
// deciding the new status, and turning an email into readable text. Italian and English patterns.

// ---------- providers ----------
export const PROVIDERS = {
  icloud:   { host: "imap.mail.me.com",        port: 993, secure: true,  domains: /(^|\.)(icloud|me|mac)\.com$/i,           help: "App-specific password: account.apple.com > Sign-In and Security > App-Specific Passwords" },
  gmail:    { host: "imap.gmail.com",          port: 993, secure: true,  domains: /^(gmail|googlemail)\.com$/i,             help: "Turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords (IMAP is always on)" },
  outlook:  { host: "outlook.office365.com",   port: 993, secure: true,  domains: /^(outlook|hotmail|live|msn)\./i,          help: "Work/school Microsoft 365 accounts with IMAP enabled work with a password. Personal Outlook.com/Hotmail accounts no longer allow password login over IMAP: use a forwarding rule into a Gmail/iCloud mailbox, or the custom provider with a local bridge" },
  yahoo:    { host: "imap.mail.yahoo.com",     port: 993, secure: true,  domains: /(^|\.)yahoo\./i,                         help: "Account security > Generate app password" },
  fastmail: { host: "imap.fastmail.com",       port: 993, secure: true,  domains: /(^|\.)fastmail\.(com|fm)$/i,             help: "Settings > Privacy & Security > Integrations > New app password (IMAP access)" },
  zoho:     { host: "imap.zoho.com",           port: 993, secure: true,  domains: /(^|\.)zoho\.(com|eu)$/i,                 help: "Enable IMAP in Zoho Mail settings and create an app-specific password" },
  gmx:      { host: "imap.gmx.com",            port: 993, secure: true,  domains: /(^|\.)(gmx|web)\.(com|de|net)$/i,        help: "Enable IMAP in GMX settings" },
  proton:   { host: "127.0.0.1",               port: 1143, secure: false, domains: /(^|\.)(proton\.me|protonmail\.com|pm\.me)$/i, help: "Needs the Proton Mail Bridge app running locally; use the Bridge username/password it shows" },
  custom:   { host: "",                        port: 993, secure: true,  domains: null,                                        help: "Set host (and port/secure) in mail-config.json" },
};
export function detectProvider(user = "") {
  const dom = (user.split("@")[1] || "").toLowerCase();
  for (const [name, p] of Object.entries(PROVIDERS)) if (p.domains && p.domains.test(dom)) return name;
  return "custom";
}

// ---------- classification (Italian + English) ----------
const RULES = [
  ["rejection", /unfortunately|regret to inform|not (be )?(moving|proceeding|going) forward|will not be (moving|proceeding)|decided (not )?to (move forward|proceed|continue) with (other|another)|other candidates|position (has been|was) filled|not (been )?selected|purtroppo|non (è|e'|sarà) possibile proseguire|non proseguire|proseguire con (altri|altre)|altri candidati|candidatura non (è|e') stata (accolta|selezionata)|non risulta in linea|non in linea con|ci dispiace|abbiamo deciso di non|non (siamo|saremo) in grado di (procedere|proseguire)/i],
  ["interview", /colloquio|interview|call conoscitiv|schedule a (call|time|chat)|book a (call|time)|calendly|invit(e|ing) you to (a|an) (call|chat|meeting)|incontro|videocall|google meet|zoom\.us|teams meeting|disponibilit[àa] per|your availability/i],
  ["test", /prova (tecnica|di pre)|pre-?selezione|assignment|take-?home|technical (test|challenge|exercise)|test tecnic|coding challenge|case study|assessment|hackerrank|codility|testgorilla|domanda di progettazione/i],
  ["info", /potresti rispondere|could you (please )?(answer|share|send|confirm|tell)|alcune domande|a few questions|following questions|rispondere alle seguenti|ti chiedo di (inviare|confermare)/i],
  ["ack", /abbiamo ricevuto|received your application|thank you for (applying|your application|your interest)|grazie per (aver|la tua|il tuo)|application (has been )?(received|submitted)|candidatura (ricevuta|inviata)|we.ll (review|be in touch)|ti contatteremo/i],
];
export function classify(subject = "", body = "") {
  const text = `${subject}\n${body}`.slice(0, 6000);
  // account / security / registration mail is never feedback on an application, whatever its body says
  if (/(account (e|è) stato creato|account (created|activated)|welcome|benvenuto|conferma (di )?registrazione|registration confirm|otp|verification code|codice di verifica|password|secure link|login attempt|sign[- ]?in)/i.test(subject)) return "other";
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  return "other";
}

// ---------- matching an email to a tracker entry ----------
const LEGAL = /\b(s\.?p\.?a\.?|s\.?r\.?l\.?s?\.?|gmbh|inc\.?|ltd\.?|llc|group|italia|italy|holding|società benefit|for client|the)\b/gi;
export const normCo = c => (c || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(LEGAL, " ").replace(/[^a-z0-9]+/g, " ").trim();
const PLATFORM = /(greenhouse|lever|ashbyhq|workable|smartrecruiters|recruitee|linkedin|indeed|teamtailor|breezy|bamboohr|jobvite|icims|workday|personio|join\.com|hirevue|hackerrank|codility|testgorilla|noreply|no-reply|mailchimp|sendgrid)/i;
export function matchEmail(mail, apps) {
  const from = (mail.from || "").toLowerCase();
  const dom = (from.match(/@([a-z0-9.-]+)/) || [])[1] || "";
  const domLabels = dom.split(".").filter(x => !["com", "it", "io", "co", "net", "org", "eu", "de", "uk", "mail", "mg", "email", "hr", "jobs", "careers"].includes(x));
  const subj = (mail.subject || "").toLowerCase();
  const head = (mail.body || "").slice(0, 600).toLowerCase();
  const isPlatform = PLATFORM.test(dom) || PLATFORM.test(from);
  const hits = [];
  for (const a of apps) {
    const n = normCo(a.company); if (n.length < 4) continue;
    const squashed = n.replace(/ /g, "");
    let strength = 0;
    if (!isPlatform && domLabels.some(l => l.length >= 4 && (l === squashed || l.includes(squashed) || squashed.includes(l)))) strength = 2;
    else if (subj.includes(n) || new RegExp(`\\b${n.replace(/ /g, "\\s+")}\\b`).test(from.replace(/@.*/, ""))) strength = 2;
    else if (isPlatform && head.includes(n)) strength = 2;
    else if ((mail.body || "").toLowerCase().includes(n)) strength = 1;
    if (strength) hits.push({ app: a, strength });
  }
  if (!hits.length) return { kind: "none" };
  const top = Math.max(...hits.map(h => h.strength));
  const best = hits.filter(h => h.strength === top);
  // several rows at one company: prefer the application that was actually sent
  const live = best.filter(h => ["Applied", "Replied", "Interviewing", "Ready to send"].includes(h.app.status));
  const pick = live.length ? live : best;
  const companies = new Set(pick.map(h => normCo(h.app.company)));
  if (companies.size > 1) return { kind: "ambiguous", candidates: pick.map(h => h.app.company) };
  if (top < 2) return { kind: "weak", app: pick[0].app };
  if (pick.length > 1 && live.length !== 1) return { kind: "ambiguous", candidates: pick.map(h => `${h.app.company} - ${h.app.role}`) };
  return { kind: "strong", app: pick[0].app };
}

// ---------- status mapping ----------
const RANK = { Found: 0, "Ready to send": 1, Applied: 2, Replied: 3, Interviewing: 4, Offer: 5 };
export function decide(kind, app) {
  if (["Rejected", "Withdrawn", "Offer"].includes(app.status)) return null; // never reopen a closed row
  if (kind === "rejection") return "Rejected";
  if (kind === "interview") return (RANK[app.status] ?? 0) >= 4 ? null : "Interviewing";
  if (kind === "test" || kind === "info") return (RANK[app.status] ?? 0) >= 3 ? null : "Replied";
  if (kind === "ack") return (RANK[app.status] ?? 0) >= 2 ? null : "Applied"; // applied but never marked it
  return null;
}


// LinkedIn and some ATS mails keep the actual message only in the HTML part, so read both
export const htmlToText = h => String(h || "").replace(/<(style|script|head)[\s\S]*?<\/(style|script|head)>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
export const bodyOf = mail => ((mail.text || "").slice(0, 2500) + "\n" + htmlToText(mail.html).slice(0, 3500)).trim();

// readable copy of a mail for the tracker card: real message only, no links, tracking or footers
const htmlLines = h => String(h || "").replace(/<(style|script|head)[\s\S]*?<\/(style|script|head)>/gi, " ").replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6]|\/li)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&middot;/g, "·").replace(/&ndash;|&mdash;/g, "-").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/[͏​-‏­⁠﻿]/g, "").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const FOOTER = /(this email was intended for|you are receiving linkedin|learn why we included this|unsubscribe|annulla l'iscrizione|view in browser|se non vuoi più ricevere|©|linkedin corporation|top jobs looking for|jobs you may be interested|similar jobs|see more jobs|recommended for you)/i;
export function cleanBody(mail) {
  let s = mail.html ? htmlLines(mail.html) : String(mail.text || "");
  if (!mail.html || s.length < 40) s = String(mail.text || "");
  s = s.replace(/https?:\/\/\S+/g, "").replace(/\[\s*\]/g, "").replace(/ {2,}/g, " ");
  const cut = s.search(FOOTER); if (cut > 40) s = s.slice(0, cut);
  return s.split("\n").map(l => l.trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== "")).join("\n").trim().slice(0, 1400);
}

