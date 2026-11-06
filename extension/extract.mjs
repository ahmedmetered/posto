// Reads a job posting out of a page's HTML: structured data first (most job pages publish a schema.org JobPosting),
// then the page title patterns of LinkedIn and Indeed. Pure function, so it is tested without a browser.

const strip = h => String(h || "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n\s*\n+/g, "\n").trim();

function jsonLdPostings(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = n => { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk); if ([].concat(n["@type"] || []).includes("JobPosting")) out.push(n); if (n["@graph"]) walk(n["@graph"]); };
    walk(data);
  }
  return out;
}
const place = loc => {
  const l = [].concat(loc || [])[0]; if (!l) return "";
  const a = l.address || {}; const c = typeof a.addressCountry === "object" ? a.addressCountry?.name : a.addressCountry;
  return [a.addressLocality, a.addressRegion, c].filter(Boolean).join(", ");
};
const meta = (html, prop) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i")) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i")); return m ? strip(m[1]) : ""; };

export function extractJob(html, url = "") {
  html = String(html || "");
  let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* no url */ }
  const source = /linkedin\./.test(host) ? "LinkedIn" : /indeed\./.test(host) ? "Indeed" : host || "web";
  const easy = /easy apply|candidatura semplice|candidati facilmente|easily apply|postulación sencilla/i.test(strip(html).slice(0, 60000));
  const jp = jsonLdPostings(html)[0];
  if (jp) {
    const remote = /TELECOMMUTE/i.test(jp.jobLocationType || "");
    const loc = place(jp.jobLocation);
    return { title: strip(jp.title || ""), company: strip(typeof jp.hiringOrganization === "object" ? jp.hiringOrganization?.name : jp.hiringOrganization || ""), location: remote ? `Remote${loc ? " - " + loc : ""}` : loc,
      description: strip(jp.description || "").slice(0, 6000), easy, source, url };
  }
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || meta(html, "og:title"));
  const li = title.match(/^(.+?) (?:is )?hiring (.+?) in (.+?)(?: \| LinkedIn)?$/i);
  if (li) return { title: li[2].trim(), company: li[1].trim(), location: li[3].trim(), description: meta(html, "og:description") || meta(html, "description"), easy, source, url };
  const parts = title.replace(/\s*[|–]\s*(Indeed|LinkedIn)[^|]*$/i, "").replace(/\s*-\s*Indeed\.[a-z.]+$/i, "").split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
  const h1 = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
  if (parts.length >= 2) return { title: parts[0], company: parts[1], location: parts[2] || "", description: meta(html, "og:description") || meta(html, "description"), easy, source, url };
  return { title: h1 || parts[0] || "", company: meta(html, "og:site_name"), location: "", description: meta(html, "og:description") || meta(html, "description"), easy, source, url };
}
