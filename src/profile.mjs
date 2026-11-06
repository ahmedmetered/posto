// The situation profile: the constraints that decide which jobs are even valid for a person.
// Everything the sweep, the match score and the CV advice do is driven by this object.

export const SENIORITY = ["intern", "junior", "mid", "senior", "lead"];
export const MODES = ["remote", "hybrid", "onsite"];
export const EMPLOYMENT = ["full_time", "part_time", "internship", "contract", "freelance"];

const arr = (v, max = 60) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : []).map(s => String(s).trim()).filter(Boolean).slice(0, max);
const code = s => String(s || "").trim().toUpperCase().slice(0, 2);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const pick = (list, v) => arr(v).map(s => s.toLowerCase()).filter(s => list.includes(s));

export function defaultProfile() {
  return {
    home_country: "", home_city: "",
    modes: ["remote", "hybrid", "onsite"],          // work modes they accept
    onsite_countries: [],                            // on-site/hybrid only in these (their own country by default)
    relocation: { open: false, countries: [], needs_sponsorship: false },
    remote_needs_home_ok: true,                      // "remote" only counts if the posting accepts people living in home_country
    employment: ["full_time", "part_time", "internship"],
    self_employed_ok: false,                         // freelance / P.IVA style contracts
    max_hours_week: null,                            // e.g. 20 for a student permit, null for no cap
    languages: ["en"],
    titles_include: [], titles_exclude: [],
    seniority_max: "mid",
    salary_floor: { amount: null, currency: "EUR", period: "year" },
    excluded_companies: [],
    tracks: [],                                      // [{name, keywords:[...], cv:"CV label"}]
  };
}

export function normalizeProfile(input = {}) {
  const d = defaultProfile(), p = { ...d };
  p.home_country = code(input.home_country);
  p.home_city = String(input.home_city || "").trim().slice(0, 80);
  const modes = pick(MODES, input.modes); p.modes = modes.length ? modes : d.modes;
  p.onsite_countries = arr(input.onsite_countries, 30).map(code).filter(Boolean);
  if (!p.onsite_countries.length && p.home_country) p.onsite_countries = [p.home_country];
  const r = input.relocation || {};
  p.relocation = { open: !!r.open, countries: arr(r.countries, 30).map(code).filter(Boolean), needs_sponsorship: !!r.needs_sponsorship };
  p.remote_needs_home_ok = input.remote_needs_home_ok !== false;
  const emp = pick(EMPLOYMENT, input.employment); p.employment = emp.length ? emp : d.employment;
  p.self_employed_ok = !!input.self_employed_ok;
  p.max_hours_week = num(input.max_hours_week, 1, 80);
  p.languages = arr(input.languages, 10).map(s => s.toLowerCase().slice(0, 2)); if (!p.languages.length) p.languages = d.languages;
  p.titles_include = arr(input.titles_include, 40).map(s => s.toLowerCase()); p.titles_exclude = arr(input.titles_exclude, 40).map(s => s.toLowerCase());
  const sm = String(input.seniority_max || "").toLowerCase(); p.seniority_max = SENIORITY.includes(sm) ? sm : d.seniority_max;
  const sf = input.salary_floor || {};
  p.salary_floor = { amount: num(sf.amount, 0, 5e6), currency: String(sf.currency || "EUR").toUpperCase().slice(0, 3), period: ["year", "month", "hour"].includes(sf.period) ? sf.period : "year" };
  p.excluded_companies = arr(input.excluded_companies, 100).map(s => s.toLowerCase());
  p.tracks = (Array.isArray(input.tracks) ? input.tracks : []).slice(0, 12).map(t => ({
    name: String(t.name || "").trim().slice(0, 60), keywords: arr(t.keywords, 40).map(s => s.toLowerCase()), cv: String(t.cv || "").trim().slice(0, 80),
  })).filter(t => t.name && t.keywords.length);
  return p;
}

// a short, plain-language reading of the profile, shown back to the person so they can check it
export function describeProfile(p) {
  const bits = [];
  if (p.home_country) bits.push(`Lives in ${p.home_city ? p.home_city + ", " : ""}${p.home_country}`);
  bits.push(`on-site or hybrid only in ${p.onsite_countries.join(", ") || "no country"}${p.relocation.open ? `, and willing to relocate to ${p.relocation.countries.join(", ") || "any country"}${p.relocation.needs_sponsorship ? " (needs visa sponsorship)" : ""}` : ""}`);
  bits.push(p.modes.includes("remote") ? (p.remote_needs_home_ok ? "remote roles count only if they accept people living in their country" : "any remote role counts") : "no remote");
  if (p.max_hours_week) bits.push(`work limited to ${p.max_hours_week} hours a week`);
  if (!p.self_employed_ok) bits.push("employee contracts only"); else bits.push("open to freelance / self-employed contracts");
  return bits.join("; ") + ".";
}
