// Core of the product: can THIS person actually take THIS job, and how well does it fit?
// Pure functions, no network, no database. evaluate(job, profile) -> { verdict, score, reasons, track }.
//
// job (normalised by the source adapters):
//   { title, company, location, remote?: boolean, employment?: "full_time"|"part_time"|"internship"|"contract"|"freelance",
//     description?, salary?: {min, max, currency, period}, sponsorship?: boolean|null, languages_required?: ["it"], posted_at?: ISO date }
// verdict: "fit" (apply), "check" (looks possible, something to confirm first), "no" (blocked, with the reason).
// reasons: [{ kind: "block"|"flag"|"plus", code, text }] - every decision is explained in plain words.

import { parseLocation, inScope, countryName, REGIONS } from "./geo.mjs";
import { SENIORITY } from "./profile.mjs";

const LANGS = { it: ["italian", "italiano"], de: ["german", "deutsch"], fr: ["french", "français", "francais"], es: ["spanish", "español", "espanol"], pt: ["portuguese", "português"], nl: ["dutch", "nederlands"], ar: ["arabic"] };

export function detectSeniority(title = "") {
  const t = title.toLowerCase();
  if (/\b(intern|internship|stage|stagista|tirocinio|trainee|working student|werkstudent)\b/.test(t)) return "intern";
  if (/\b(junior|jr\.?|entry.?level|graduate|associate|apprentice)\b/.test(t)) return "junior";
  if (/\b(principal|staff|head of|director|vp\b|vice president|distinguished|chief)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?|lead|expert)\b/.test(t)) return "senior";
  return "mid";
}

export function detectEmployment(job) {
  if (job.employment) return { value: job.employment, inferred: false };
  const t = `${job.title || ""} ${(job.description || "").slice(0, 700)}`.toLowerCase();
  if (/\b(intern|internship|stage|stagista|tirocinio|working student|werkstudent)\b/.test(t)) return { value: "internship", inferred: true };
  if (/part.?time/.test(t)) return { value: "part_time", inferred: true };
  if (/\b(freelance|freelancer|partita iva|p\.? ?iva|self.?employed|independent contractor)\b/.test(t)) return { value: "freelance", inferred: true };
  if (/\b(fixed.?term|contract role|contractor|tempo determinato)\b/.test(t)) return { value: "contract", inferred: true };
  return { value: "full_time", inferred: true };
}

export function detectLanguages(text = "") {
  const t = text.toLowerCase(), out = [];
  for (const [code, names] of Object.entries(LANGS)) for (const n of names) {
    const re = new RegExp(`\\b(fluent|native|proficien\\w*|madrelingua|mother tongue|excellent|required|must|ottima conoscenza)\\b.{0,30}\\b${n}\\b|\\b${n}\\b.{0,18}\\b(fluent|native|required|speaking|speaker|madrelingua|mandatory)|\\b${n}[- ]speaking|\\bw/ ?${n}\\b|\\bwith ${n}\\b`, "i");
    if (re.test(t)) { out.push(code); break; }
  }
  return out;
}

const yearly = (s, period) => (s == null ? null : period === "hour" ? s * 1800 : period === "month" ? s * 12 : period === "day" ? s * 220 : s);

export function evaluate(job, profile) {
  const reasons = [], R = (kind, code, text) => reasons.push({ kind, code, text });
  const title = job.title || "", titleL = title.toLowerCase(), descL = (job.description || "").toLowerCase();
  const home = profile.home_country;

  // 1. hard personal exclusions
  if ((profile.excluded_companies || []).some(c => c && (job.company || "").toLowerCase().includes(c))) R("block", "company_excluded", `You excluded ${job.company}.`);
  const bad = (profile.titles_exclude || []).find(w => w && titleL.includes(w));
  if (bad) R("block", "title_excluded", `The title contains "${bad}", which you excluded.`);

  if (/\b(volunteer|volunteering|unpaid|no pay)\b/i.test(title)) R("block", "unpaid", "Unpaid or volunteer role.");

  // 2. where and how: location, work mode, remote eligibility
  const loc = parseLocation(job.location, { remote: job.remote });
  const allowedOnsite = new Set(profile.onsite_countries || []);
  const reloc = profile.relocation || {};
  let needsRelocation = false;
  if (loc.mode === "remote") {
    if (!profile.modes.includes("remote")) R("block", "no_remote", "Remote role, and you only want on-site or hybrid.");
    else {
      const scope = inScope(loc, home);
      if (scope === true) R("plus", "remote_ok", loc.worldwide ? "Remote from anywhere." : "Remote, and it accepts people living in your country.");
      else if (scope === false) {
        const named = [...loc.countries.map(countryName), ...loc.regions].join(", ");
        const viaReloc = reloc.open && loc.countries.some(c => !reloc.countries.length || reloc.countries.includes(c));
        if (viaReloc) { needsRelocation = true; R("flag", "remote_needs_move", `Remote, but only for people living in ${named}. It would mean moving there.`); }
        else if (profile.remote_needs_home_ok) R("block", "remote_not_for_you", `Remote, but limited to ${named}, not your country.`);
        else R("flag", "remote_region", `Remote, limited to ${named}. Check whether it applies to you.`);
      } else R("flag", "remote_region_unknown", "Remote, but the posting does not say which countries it accepts. Confirm before applying.");
    }
  } else if (loc.mode === "onsite" || loc.mode === "hybrid") {
    if (!profile.modes.includes(loc.mode)) R("block", "mode_not_wanted", `${loc.mode === "hybrid" ? "Hybrid" : "On-site"} role, which you do not want.`);
    else if (!loc.countries.length) R("flag", "location_unknown", "The posting does not give a clear location. Confirm before applying.");
    else {
      const here = loc.countries.some(c => allowedOnsite.has(c));
      const relo = reloc.open && loc.countries.some(c => !reloc.countries.length || reloc.countries.includes(c));
      if (here) R("plus", "onsite_ok", `${loc.mode === "hybrid" ? "Hybrid" : "On-site"} in ${loc.countries.map(countryName).join(", ")}, where you are.`);
      else if (relo) { needsRelocation = true; R("flag", "needs_relocation", `${loc.mode === "hybrid" ? "Hybrid" : "On-site"} in ${loc.countries.map(countryName).join(", ")}: you would have to move.`); }
      else R("block", "wrong_country", `${loc.mode === "hybrid" ? "Hybrid" : "On-site"} in ${loc.countries.map(countryName).join(", ")}, and you only work on-site in ${[...allowedOnsite].map(countryName).join(", ") || "your country"}.`);
    }
  } else R("flag", "location_unknown", "Location and work mode are unclear. Confirm before applying.");

  // 3. visa sponsorship when the move is part of the deal
  if (needsRelocation && reloc.needs_sponsorship) {
    if (job.sponsorship === false) R("block", "no_sponsorship", "You need visa sponsorship and the posting says it does not offer it.");
    else if (job.sponsorship === true) R("plus", "sponsorship", "The employer offers visa sponsorship or relocation help.");
    else R("flag", "sponsorship_unknown", "You need visa sponsorship: ask whether they offer it before investing time.");
  }

  // 4. hours and contract type (work permits, student limits, self-employment)
  const emp = detectEmployment(job);
  if (profile.max_hours_week && emp.value === "full_time") {
    if (emp.inferred) R("flag", "hours_unclear", `Probably full-time, and you can work ${profile.max_hours_week} hours a week. Ask if part-time is possible.`);
    else R("block", "full_time_limit", `Full-time, and you are limited to ${profile.max_hours_week} hours a week.`);
  }
  if (emp.value === "freelance") {
    if (!profile.self_employed_ok) R("block", "no_freelance", "Freelance / self-employed contract, and you only want employee roles.");
    else if (profile.max_hours_week) R("flag", "permit_selfemployment", "Self-employed contract while on a limited work permit: confirm with an official source that your permit allows it.");
  }
  if (!["freelance"].includes(emp.value) && !profile.employment.includes(emp.value) && !emp.inferred) R("block", "employment_type", `The contract type (${emp.value.replace("_", "-")}) is not one you accept.`);

  // 5. languages
  const need = job.languages_required && job.languages_required.length ? job.languages_required : detectLanguages(`${title}. ${job.description || ""}`);
  const missing = need.filter(l => !profile.languages.includes(l));
  if (missing.length) R("block", "language", `Requires ${missing.join(", ")}, which is not in your languages.`);

  // 6. seniority
  const sen = detectSeniority(title), maxRank = SENIORITY.indexOf(profile.seniority_max), rank = SENIORITY.indexOf(sen);
  if (rank > maxRank && sen !== "mid") R("block", "seniority", `A ${sen} role, above the level you set.`);
  else if (sen === "mid" && maxRank <= 1) R("flag", "seniority_unclear", "The posting does not say the level, and you are looking for junior roles.");

  // 7. pay
  const floor = profile.salary_floor || {};
  if (floor.amount && job.salary && job.salary.currency === floor.currency) {
    const top = yearly(job.salary.max ?? job.salary.min, job.salary.period || "year"), want = yearly(floor.amount, floor.period);
    if (top != null && top < want) R("block", "salary_low", `Pays up to ${Math.round(top)} ${floor.currency} a year, below your floor of ${Math.round(want)}.`);
    else if (top != null) R("plus", "salary_ok", "Stated pay meets your floor.");
  }

  // 8. does it match what they are looking for
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (text, k) => new RegExp(`(?<![a-z0-9])${esc(k)}(?![a-z0-9])`, "i").test(text);
  let track = null, hit = 0, titleHit = false;
  for (const tr of profile.tracks || []) {
    const inTitle = tr.keywords.filter(k => has(titleL, k)).length, inDesc = tr.keywords.filter(k => has(descL, k)).length;
    const s = inTitle * 3 + Math.min(inDesc, 2);
    if (inTitle && s > hit) { hit = s; track = tr; titleHit = true; }
  }
  const inc = (profile.titles_include || []).some(w => w && has(titleL, w));
  const wantsSomething = (profile.tracks || []).length || (profile.titles_include || []).length;
  if (wantsSomething && !titleHit && !inc) R("block", "off_track", "The title does not match any of the role types you are looking for.");
  else if (track) R("plus", "track", `Matches your "${track.name}" track.`);

  // verdict + score
  const blocked = reasons.some(r => r.kind === "block"), flags = reasons.filter(r => r.kind === "flag").length, plus = reasons.filter(r => r.kind === "plus").length;
  let score = 40 + Math.min(hit, 6) * 5 + plus * 4 - flags * 6;
  if (job.posted_at) { const d = (Date.now() - new Date(job.posted_at).getTime()) / 864e5; if (d <= 3) score += 10; else if (d <= 7) score += 5; else if (d > 30) score -= 10; }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { verdict: blocked ? "no" : flags ? "check" : "fit", score: blocked ? Math.min(score, 25) : score, reasons, track: track ? { name: track.name, cv: track.cv } : null };
}

export { REGIONS };
