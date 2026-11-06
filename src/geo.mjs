// Places: country/city/region lookup and a parser that turns free-text job locations into structure.
// Country codes are ISO 3166-1 alpha-2.

const C = {
  AT: ["austria", "österreich", "vienna", "wien"], BE: ["belgium", "belgique", "brussels", "bruxelles"], BG: ["bulgaria", "sofia"],
  HR: ["croatia", "zagreb"], CY: ["cyprus", "nicosia"], CZ: ["czech republic", "czechia", "prague", "praha"], DK: ["denmark", "copenhagen"],
  EE: ["estonia", "tallinn"], FI: ["finland", "helsinki"], FR: ["france", "paris", "lyon", "marseille", "toulouse"],
  DE: ["germany", "deutschland", "berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln", "stuttgart", "düsseldorf"],
  GR: ["greece", "athens"], HU: ["hungary", "budapest"], IE: ["ireland", "dublin", "cork", "galway"],
  IT: ["italy", "italia", "milan", "milano", "rome", "roma", "turin", "torino", "bologna", "florence", "firenze", "naples", "napoli", "padua", "padova", "verona", "genoa", "genova", "bergamo", "brescia", "monza", "segrate", "lombardy", "lombardia"],
  LV: ["latvia", "riga"], LT: ["lithuania", "vilnius"], LU: ["luxembourg"], MT: ["malta", "valletta"], NL: ["netherlands", "the netherlands", "holland", "amsterdam", "rotterdam", "utrecht", "eindhoven", "the hague"],
  PL: ["poland", "warsaw", "krakow", "kraków", "wroclaw", "gdansk"], PT: ["portugal", "lisbon", "lisboa", "porto"], RO: ["romania", "bucharest"],
  SK: ["slovakia", "bratislava"], SI: ["slovenia", "ljubljana"], ES: ["spain", "españa", "madrid", "barcelona", "valencia", "seville", "sevilla", "malaga", "málaga"],
  SE: ["sweden", "stockholm", "gothenburg"], IS: ["iceland", "reykjavik"], LI: ["liechtenstein"], NO: ["norway", "oslo"], CH: ["switzerland", "zurich", "zürich", "geneva", "basel", "lausanne"],
  GB: ["united kingdom", "uk", "u.k.", "england", "scotland", "wales", "great britain", "london", "manchester", "edinburgh", "birmingham", "bristol", "cambridge"],
  RS: ["serbia", "belgrade"], UA: ["ukraine", "kyiv", "kiev"], AL: ["albania", "tirana"], BA: ["bosnia"], ME: ["montenegro"], MK: ["north macedonia"], MD: ["moldova"],
  US: ["united states", "usa", "u.s.", "u.s.a.", "us", "america", "new york", "san francisco", "boston", "seattle", "austin", "chicago", "los angeles", "denver", "atlanta"],
  CA: ["canada", "toronto", "vancouver", "montreal", "ottawa", "calgary"], MX: ["mexico", "méxico"],
  BR: ["brazil", "brasil", "são paulo", "sao paulo"], AR: ["argentina", "buenos aires"], CL: ["chile", "santiago"], CO: ["colombia", "bogota", "bogotá"], PE: ["peru", "lima"], UY: ["uruguay", "montevideo"],
  AE: ["united arab emirates", "uae", "dubai", "abu dhabi"], SA: ["saudi arabia", "ksa", "riyadh", "jeddah"], QA: ["qatar", "doha"], KW: ["kuwait"], BH: ["bahrain"], OM: ["oman", "muscat"],
  IL: ["israel", "tel aviv"], JO: ["jordan", "amman"], TR: ["turkey", "türkiye", "turkiye", "istanbul", "ankara"], EG: ["egypt", "cairo"],
  ZA: ["south africa", "cape town", "johannesburg"], NG: ["nigeria", "lagos"], KE: ["kenya", "nairobi"], GH: ["ghana", "accra"], MA: ["morocco", "casablanca"], TN: ["tunisia", "tunis"],
  IN: ["india", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune", "chennai"], PK: ["pakistan", "karachi", "lahore"], BD: ["bangladesh", "dhaka"], LK: ["sri lanka", "colombo"],
  SG: ["singapore"], MY: ["malaysia", "kuala lumpur"], TH: ["thailand", "bangkok"], VN: ["vietnam", "ho chi minh", "hanoi"], ID: ["indonesia", "jakarta"], PH: ["philippines", "manila"],
  JP: ["japan", "tokyo", "osaka"], KR: ["south korea", "korea", "seoul"], CN: ["china", "shanghai", "beijing", "shenzhen"], HK: ["hong kong"], TW: ["taiwan", "taipei"],
  AU: ["australia", "sydney", "melbourne", "brisbane", "perth"], NZ: ["new zealand", "auckland", "wellington"],
};

export const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
const EUROPE_EXTRA = ["IS", "LI", "NO", "CH", "GB", "RS", "UA", "AL", "BA", "ME", "MK", "MD"];
const MIDDLE_EAST = ["AE", "SA", "QA", "KW", "BH", "OM", "IL", "JO", "TR", "EG"];
const AFRICA = ["ZA", "NG", "KE", "GH", "MA", "TN", "EG"];
export const REGIONS = {
  EU: EU,
  EEA: [...EU, "IS", "LI", "NO"],
  EUROPE: [...EU, ...EUROPE_EXTRA],
  EMEA: [...EU, ...EUROPE_EXTRA, ...MIDDLE_EAST, ...AFRICA],
  MENA: [...MIDDLE_EAST, "MA", "TN"],
  GCC: ["AE", "SA", "QA", "KW", "BH", "OM"],
  NA: ["US", "CA"],
  AMERICAS: ["US", "CA", "MX", "BR", "AR", "CL", "CO", "PE", "UY"],
  LATAM: ["MX", "BR", "AR", "CL", "CO", "PE", "UY"],
  APAC: ["IN", "PK", "BD", "LK", "SG", "MY", "TH", "VN", "ID", "PH", "JP", "KR", "CN", "HK", "TW", "AU", "NZ"],
};
// phrases that name a region
const REGION_WORDS = [
  ["EEA", /\beea\b|european economic area/], ["EU", /\b(eu|e\.u\.|european union)\b/], ["EUROPE", /\beurope(an)?\b/], ["EMEA", /\bemea\b/],
  ["MENA", /\bmena\b|middle east/], ["GCC", /\bgcc\b|\bgulf\b/], ["NA", /north america|\bamericas?\b(?! latin)/], ["LATAM", /\blatam\b|latin america/], ["APAC", /\bapac\b|asia.?pacific/],
];
const WORLDWIDE = /anywhere(?! in\b)|worldwide|world.?wide|global(ly)?\b|any location|all countries/;

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PLACES = []; // [regex, country]
for (const [code, names] of Object.entries(C)) for (const n of names) PLACES.push([new RegExp(`(?<![a-zà-ÿ])${esc(n)}(?![a-zà-ÿ])`, "i"), code, n.length]);
PLACES.sort((a, b) => b[2] - a[2]);

export const countryName = code => (C[code] || [code])[0].replace(/\b\w/g, c => c.toUpperCase());
export const regionOf = code => Object.entries(REGIONS).filter(([, list]) => list.includes(code)).map(([r]) => r);

// "Remote - EMEA", "Milan, Italy (Hybrid)", "Berlin or Remote Germany", "United States (Remote)"
export function parseLocation(raw = "", hints = {}) {
  const text = String(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
  const out = { raw: String(raw || ""), mode: "unknown", countries: [], regions: [], worldwide: false };
  let rest = text;
  for (const [reg, re] of REGION_WORDS) if (re.test(rest)) { out.regions.push(reg); rest = rest.replace(re, " "); }
  for (const [re, code] of PLACES) { if (re.test(rest)) { if (!out.countries.includes(code)) out.countries.push(code); rest = rest.replace(re, " "); } }
  out.worldwide = WORLDWIDE.test(text);
  const remote = /\bremote(ly)?\b|work from home|\bwfh\b|home.?based|fully distributed|telecommut|anywhere in\b/.test(text) || hints.remote === true || out.worldwide;
  const hybrid = /\bhybrid\b/.test(text) || hints.mode === "hybrid";
  const onsite = /on.?site|in.?office|in.?person|\boffice\b/.test(text) || hints.mode === "onsite";
  out.mode = hybrid ? "hybrid" : remote && !onsite ? "remote" : onsite ? "onsite" : (out.countries.length && !remote ? "onsite" : "unknown");
  if (hints.mode === "remote") out.mode = "remote";
  if (hints.remote === false && out.mode === "remote") out.mode = out.countries.length ? "onsite" : "unknown";
  return out;
}

// is the person's home country inside what the posting names? true / false / null (the posting does not say)
export function inScope(parsed, home) {
  if (parsed.worldwide) return true;
  if (parsed.countries.includes(home)) return true;
  if (parsed.regions.some(r => (REGIONS[r] || []).includes(home))) return true;
  if (parsed.countries.length || parsed.regions.length) return false;
  return null;
}

export const countryList = () => Object.keys(C).map(code => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name));
