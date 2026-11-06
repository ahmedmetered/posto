// Job sources. Every adapter has a pure parse function (tested with fixtures) and a fetch function (network).
// All of them return the same normalised job: { source, ext_id, company, title, location, remote, employment,
//   description, url, salary, sponsorship, posted_at }.
// Only public, documented feeds are used here: company ATS boards and remote-job APIs.

const UA = { "user-agent": "Mozilla/5.0 (compatible; jobsaas/0.1)" };
export const stripHtml = h => String(h || "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const clip = (s, n = 1800) => String(s || "").slice(0, n);
const iso = v => { if (!v) return null; const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v); return isNaN(d) ? null : d.toISOString(); };
const SPONSOR_YES = /visa sponsorship|we sponsor|relocation (support|package|assistance|bonus)|sponsorship (is )?available/i;
const SPONSOR_NO = /(no|not|unable to|cannot|can't|don't|do not) (offer |provide )?(visa )?sponsor|without sponsorship|must have (the )?right to work|authori[sz]ed to work (in|without)/i;
export const sponsorshipFrom = text => (SPONSOR_NO.test(text) ? false : SPONSOR_YES.test(text) ? true : null);

async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const EMP = { fulltime: "full_time", parttime: "part_time", intern: "internship", internship: "internship", contract: "contract", contractor: "contract", temporary: "contract", freelance: "freelance" };
const emp = v => EMP[String(v || "").toLowerCase().replace(/[^a-z]/g, "")] || null;

// ---------- Greenhouse ----------
export function parseGreenhouse(raw, board) {
  return (raw.jobs || []).map(j => {
    const text = stripHtml(j.content);
    return { source: "greenhouse", ext_id: String(j.id), company: j.company_name || board, title: j.title, location: j.location?.name || "", remote: null, employment: null,
      description: clip(text), url: j.absolute_url, salary: null, sponsorship: sponsorshipFrom(text), posted_at: iso(j.first_published || j.updated_at) };
  });
}
export const fetchGreenhouse = async board => parseGreenhouse(await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`), board);

// ---------- Ashby ----------
export function parseAshby(raw, board) {
  return (raw.jobs || []).filter(j => j.isListed !== false).map(j => {
    const text = j.descriptionPlain || stripHtml(j.descriptionHtml);
    const comp = j.compensation?.summaryComponents?.find(c => c.compensationType === "Salary");
    return { source: "ashby", ext_id: String(j.id), company: board, title: j.title, location: j.location || "", remote: j.isRemote === true ? true : j.workplaceType === "Remote" ? true : null,
      employment: emp(j.employmentType), description: clip(text), url: j.jobUrl, sponsorship: sponsorshipFrom(text), posted_at: iso(j.publishedAt),
      salary: comp ? { min: comp.minValue, max: comp.maxValue, currency: comp.currencyCode, period: /hour/i.test(comp.interval) ? "hour" : /month/i.test(comp.interval) ? "month" : "year" } : null };
  });
}
export const fetchAshby = async board => parseAshby(await getJson(`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`), board);

// ---------- Lever ----------
export function parseLever(raw, board) {
  return (Array.isArray(raw) ? raw : []).map(j => {
    const text = j.descriptionPlain || stripHtml(j.description);
    const wt = String(j.workplaceType || "").toLowerCase();
    return { source: "lever", ext_id: String(j.id), company: board, title: j.text, location: j.categories?.location || (j.country || ""), remote: wt === "remote" ? true : wt === "on-site" ? false : null,
      employment: emp(j.categories?.commitment), description: clip(text), url: j.hostedUrl, salary: null, sponsorship: sponsorshipFrom(text), posted_at: iso(j.createdAt) };
  });
}
export const fetchLever = async board => parseLever(await getJson(`https://api.lever.co/v0/postings/${board}?mode=json`), board);

// ---------- Himalayas (remote, worldwide) ----------
export function parseHimalayas(raw) {
  return (raw.jobs || []).map(j => {
    const restr = j.locationRestrictions || [];
    const text = stripHtml(j.description || j.excerpt || "");
    return { source: "himalayas", ext_id: String(j.guid || j.applicationLink), company: j.companyName, title: j.title, location: restr.length ? `Remote - ${restr.join(", ")}` : "Remote - Worldwide", remote: true,
      employment: emp(j.employmentType), description: clip(text), url: j.applicationLink, sponsorship: sponsorshipFrom(text), posted_at: iso(+j.pubDate || j.pubDate),
      salary: j.minSalary ? { min: j.minSalary, max: j.maxSalary, currency: j.currency, period: j.salaryPeriod === "hourly" ? "hour" : j.salaryPeriod === "monthly" ? "month" : "year" } : null };
  });
}
export async function fetchHimalayas(queries = ["product manager"]) {
  const out = new Map();
  for (const q of queries) for (let page = 1; page <= 3; page++) {
    let d; try { d = await getJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&sort=recent&page=${page}`); } catch { break; }
    for (const j of parseHimalayas(d)) out.set(j.ext_id, j);
    if ((d.jobs || []).length < 10) break;
  }
  return [...out.values()];
}

// ---------- Remotive (remote) ----------
export function parseRemotive(raw) {
  return (raw.jobs || []).map(j => {
    const text = stripHtml(j.description);
    return { source: "remotive", ext_id: String(j.id), company: j.company_name, title: j.title, location: `Remote - ${j.candidate_required_location || "Worldwide"}`, remote: true,
      employment: emp(j.job_type), description: clip(text), url: j.url, salary: null, sponsorship: sponsorshipFrom(text), posted_at: iso(j.publication_date) };
  });
}
export const fetchRemotive = async (search = "") => parseRemotive(await getJson(`https://remotive.com/api/remote-jobs${search ? "?search=" + encodeURIComponent(search) : ""}`));

// ---------- RemoteOK (remote; its terms ask for a visible credit and a link back, which the UI shows as "via remoteok") ----------
export function parseRemoteOk(raw) {
  return (Array.isArray(raw) ? raw : []).filter(j => j && j.position && j.id).map(j => {
    const text = stripHtml(j.description);
    return { source: "remoteok", ext_id: String(j.id), company: j.company, title: j.position, location: `Remote - ${j.location || "Worldwide"}`, remote: true, employment: null,
      description: clip(text), url: j.url || j.apply_url, sponsorship: sponsorshipFrom(text), posted_at: iso(j.date || j.epoch),
      salary: j.salary_min ? { min: j.salary_min, max: j.salary_max || j.salary_min, currency: "USD", period: "year" } : null };
  });
}
export const fetchRemoteOk = async () => parseRemoteOk(await getJson("https://remoteok.com/api"));

// ---------- We Work Remotely (RSS) ----------
const tag = (x, n) => { const m = x.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : ""; };
const unescapeXml = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
export function parseWwr(xml) {
  return String(xml || "").split("<item>").slice(1).map(x => x.split("</item>")[0]).map(x => {
    const full = unescapeXml(tag(x, "title")), i = full.indexOf(":"), text = stripHtml(unescapeXml(tag(x, "description")));
    const region = tag(x, "region"), country = tag(x, "country");
    const scope = [country, region].filter(Boolean).join(", ").replace(/\s*only$/i, "");
    return { source: "wwr", ext_id: tag(x, "guid") || tag(x, "link"), company: i > 0 ? full.slice(0, i).trim() : "", title: i > 0 ? full.slice(i + 1).trim() : full,
      location: `Remote - ${scope || "Worldwide"}`, remote: true, employment: emp(tag(x, "type")), description: clip(text), url: tag(x, "link"), salary: null,
      sponsorship: sponsorshipFrom(text), posted_at: iso(tag(x, "pubDate")) };
  }).filter(j => j.title && j.url);
}
export async function fetchWwr() {
  const r = await fetch("https://weworkremotely.com/remote-jobs.rss", { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status} weworkremotely`);
  return parseWwr(await r.text());
}

// ---------- Arbeitnow (Germany and Europe, includes on-site) ----------
export function parseArbeitnow(raw) {
  return (raw.data || []).map(j => {
    const text = stripHtml(j.description), loc = String(j.location || "");
    const type = (j.job_types || []).join(" ");
    return { source: "arbeitnow", ext_id: String(j.slug), company: j.company_name, title: j.title, location: j.remote ? `Remote - ${loc || "Germany"}` : (/germany|deutschland/i.test(loc) ? loc : `${loc}, Germany`),
      remote: j.remote === true ? true : null, employment: /part/i.test(type) ? "part_time" : /intern|praktik|werkstud/i.test(type) ? "internship" : /full/i.test(type) ? "full_time" : /contract|freelance/i.test(type) ? "contract" : null,
      description: clip(text), url: j.url, salary: null, sponsorship: sponsorshipFrom(text), posted_at: iso(j.created_at) };
  });
}
export const fetchArbeitnow = async () => parseArbeitnow(await getJson("https://www.arbeitnow.com/api/job-board-api"));

// ---------- Jobicy (remote) ----------
export function parseJobicy(raw) {
  return (raw.jobs || []).map(j => {
    const text = stripHtml(j.jobDescription || j.jobExcerpt);
    const geo = [].concat(j.jobGeo || []).join(", ");
    return { source: "jobicy", ext_id: String(j.id), company: j.companyName, title: j.jobTitle, location: `Remote - ${/anywhere|worldwide/i.test(geo) || !geo ? "Worldwide" : geo}`, remote: true,
      employment: emp([].concat(j.jobType || [])[0]), description: clip(text), url: j.url, sponsorship: sponsorshipFrom(text), posted_at: iso(j.pubDate),
      salary: j.salaryMin ? { min: j.salaryMin, max: j.salaryMax || j.salaryMin, currency: j.salaryCurrency || "USD", period: /hour/i.test(j.salaryPeriod) ? "hour" : /month/i.test(j.salaryPeriod) ? "month" : "year" } : null };
  });
}
export const fetchJobicy = async () => parseJobicy(await getJson("https://jobicy.com/api/v2/remote-jobs?count=100"));

// ---------- company boards on Workable, Recruitee, SmartRecruiters ----------
export function parseWorkable(raw, board) {
  return (raw.results || []).map(j => {
    const loc = j.location || {}, remote = j.remote === true || j.workplace === "remote";
    const place = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
    return { source: "workable", ext_id: String(j.shortcode || j.id), company: board, title: j.title, location: remote ? `Remote - ${loc.country || "Worldwide"}` : place, remote: remote ? true : j.workplace === "on_site" ? false : null,
      employment: j.type === "part" ? "part_time" : j.type === "full" ? "full_time" : emp(j.type), description: "", url: `https://apply.workable.com/${board}/j/${j.shortcode}/`, salary: null, sponsorship: null, posted_at: iso(j.published) };
  });
}
export async function fetchWorkable(board) {
  const r = await fetch(`https://apply.workable.com/api/v3/accounts/${board}/jobs`, { method: "POST", headers: { ...UA, "content-type": "application/json" }, body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }), signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status} workable/${board}`);
  return parseWorkable(await r.json(), board);
}

export function parseRecruitee(raw, board) {
  return (raw.offers || []).filter(j => j.status !== "closed").map(j => {
    const text = stripHtml(j.description), code = String(j.employment_type_code || "");
    const part = j.max_hours && +j.max_hours <= 30;
    return { source: "recruitee", ext_id: String(j.guid || j.id), company: j.company_name || board, title: j.title, location: j.remote ? `Remote - ${j.country || "Worldwide"}` : (j.location || [j.city, j.country].filter(Boolean).join(", ")),
      remote: j.remote === true ? true : null, employment: part ? "part_time" : /intern/.test(code) ? "internship" : /freelance|contract/.test(code) ? "contract" : /full/.test(code) ? "full_time" : null,
      description: clip(text), url: j.careers_url, sponsorship: sponsorshipFrom(text), posted_at: iso((j.published_at || "").replace(" UTC", "Z").replace(" ", "T")),
      salary: j.salary && j.salary.min ? { min: j.salary.min, max: j.salary.max || j.salary.min, currency: j.salary.currency, period: j.salary.period === "hour" ? "hour" : j.salary.period === "month" ? "month" : "year" } : null };
  });
}
export const fetchRecruitee = async board => parseRecruitee(await getJson(`https://${board}.recruitee.com/api/offers/`), board);

export function parseSmartRecruiters(raw, board) {
  return (raw.content || []).map(j => {
    const l = j.location || {}, type = (j.typeOfEmployment || {}).label || "";
    return { source: "smartrecruiters", ext_id: String(j.id), company: j.company?.name || board, title: j.name, location: l.remote ? `Remote - ${String(l.country || "").toUpperCase() || "Worldwide"}` : [l.city, l.country && String(l.country).toUpperCase()].filter(Boolean).join(", "),
      remote: l.remote === true ? true : null, employment: /part/i.test(type) ? "part_time" : /intern/i.test(type) ? "internship" : /contract|temporary/i.test(type) ? "contract" : /full/i.test(type) ? "full_time" : null,
      description: "", url: `https://jobs.smartrecruiters.com/${board}/${j.id}`, salary: null, sponsorship: null, posted_at: iso(j.releasedDate) };
  });
}
export const fetchSmartRecruiters = async board => parseSmartRecruiters(await getJson(`https://api.smartrecruiters.com/v1/companies/${board}/postings?limit=100`), board);

export const ADAPTERS = { greenhouse: fetchGreenhouse, ashby: fetchAshby, lever: fetchLever, workable: fetchWorkable, recruitee: fetchRecruitee, smartrecruiters: fetchSmartRecruiters };
// feeds that are not tied to one company: name -> fetch
export const FEEDS = { remoteok: fetchRemoteOk, wwr: fetchWwr, arbeitnow: fetchArbeitnow, jobicy: fetchJobicy };
