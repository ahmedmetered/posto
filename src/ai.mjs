import { BUILDER_RULES } from "./cvbuild.mjs";

// Optional AI help for tailoring a CV or writing a cover letter. Off unless the user sets it up.
// Works with Anthropic, any OpenAI-compatible endpoint (OpenAI, OpenRouter, ...), and local models (Ollama, LM Studio),
// so a person can keep everything on their own machine. The keyword comparison in cv.mjs works without any of this.

export const AI_PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  openai: { label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  ollama: { label: "Ollama (local, no key)", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
};

export function aiConfigFromInput(input) {
  const provider = AI_PROVIDERS[input.provider] ? input.provider : "";
  if (!provider) return null;
  const d = AI_PROVIDERS[provider];
  return { provider, baseUrl: String(input.baseUrl || d.baseUrl).trim().replace(/\/+$/, ""), model: String(input.model || d.model).trim() };
}

async function call(cfg, system, prompt, fetchImpl) {
  const signal = AbortSignal.timeout(cfg.provider === "ollama" ? 600000 : 120000); // a local model on a CPU can take minutes
  if (cfg.provider === "anthropic") {
    const r = await fetchImpl(`${cfg.baseUrl}/v1/messages`, { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 1500, system, messages: [{ role: "user", content: prompt }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `AI request failed (${r.status})`);
    return (j.content || []).map(c => c.text || "").join("").trim();
  }
  const r = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...(cfg.provider === "ollama" ? { reasoning_effort: "none" } : {}) }) }); // thinking models (qwen3, ...) are minutes slower with thinking on
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `AI request failed (${r.status})`);
  return String(j.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const RULES = "Use only facts that are in the CV. Never invent employers, dates, numbers, degrees or skills. If the posting asks for something the CV does not show, do not claim it. Plain text, no markdown headings.";
const KINDS = {
  summary: { system: `You help a job seeker tailor their CV. ${RULES}`, ask: "Write a 3-4 line professional summary for the top of this CV, aimed at this job, then list up to 5 existing CV bullet points (quoted from the CV) that should be moved higher because they match the posting." },
  cover_letter: { system: `You write short, specific cover letters in the candidate's own voice. ${RULES}`, ask: "Write a cover letter of at most 180 words for this job. No generic openings, no flattery. Lead with the one or two most relevant things from the CV." },
  cv: { system: `You tailor a CV for one job posting. ${RULES} One page. Lead with evidence (shipped work, live products, repositories with tests). Mirror the posting's vocabulary only where it is true. Reframe, never invent. Keep dates, grades and numbers exact. If it will not fit, cut the weakest bullet, never the font size.`, ask: "Return the tailored CV as plain text, section by section, keeping the candidate's own wording wherever it already fits. Then, under the line TO TELL THE CANDIDATE, list anything the posting asks for that the CV does not show." },
  cv_json: { system: `You tailor a CV for one job posting and return it as data for a CV builder. ${RULES}`, ask: `Tailor the CV to this job: lead with the evidence that matches it, mirror the posting's vocabulary only where it is true, cut what is least relevant. ${BUILDER_RULES}` },
  gaps: { system: `You give honest, practical CV feedback. ${RULES}`, ask: "List what the posting asks for that the CV does not show, and for each say whether it is a real gap or just missing from the wording. Then give 3 concrete edits to the CV." },
};
// the models a local Ollama has downloaded, so the settings page can offer them instead of a typed name
export async function ollamaModels(baseUrl, fetchImpl = fetch) {
  const root = String(baseUrl || "http://localhost:11434/v1").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const r = await fetchImpl(root + "/api/tags", { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("Ollama answered " + r.status);
  return ((await r.json()).models || []).map(m => m.name);
}
export const TAILOR_KINDS = Object.keys(KINDS);

// the same instructions and material as plain text, to hand to an AI agent the user already has (nothing is sent anywhere)
export function agentBrief(kind, { cv, job }) {
  const k = KINDS[kind]; if (!k) throw new Error("Unknown kind.");
  return `${k.system}\n\n${k.ask}\n\n=== JOB ===\n${job.title} at ${job.company}\n${job.location || ""}\n${String(job.description || "").slice(0, 6000)}\n\n=== CV ===\n${String(cv).slice(0, 12000)}`;
}

export async function tailor(cfg, kind, { cv, job }, fetchImpl = fetch) {
  const k = KINDS[kind]; if (!k) throw new Error("Unknown kind.");
  if (!cfg) throw new Error("Set up an AI provider in Settings first.");
  const prompt = `${k.ask}\n\n=== JOB ===\n${job.title} at ${job.company}\n${job.location || ""}\n${String(job.description || "").slice(0, 3500)}\n\n=== CV ===\n${String(cv).slice(0, 7000)}`;
  const text = await call(cfg, k.system, prompt, fetchImpl);
  if (!text) throw new Error("The model returned nothing. Try again.");
  return text;
}
