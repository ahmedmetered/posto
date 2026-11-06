import test from "node:test";
import assert from "node:assert/strict";
import { parseLocation, inScope } from "../src/geo.mjs";
import { normalizeProfile, describeProfile } from "../src/profile.mjs";
import { evaluate, detectSeniority, detectEmployment, detectLanguages } from "../src/eligibility.mjs";

const tracks = [{ name: "Product", keywords: ["product manager", "product owner", "product builder"], cv: "Product EN" }, { name: "QA", keywords: ["test automation", "qa engineer"], cv: "QA CV" }];
const student = normalizeProfile({ home_country: "it", modes: ["remote", "hybrid", "onsite"], max_hours_week: 20, languages: ["en", "it"], seniority_max: "mid", tracks, employment: ["part_time", "internship", "full_time"] });
const relocator = normalizeProfile({ home_country: "EG", modes: ["remote", "onsite"], onsite_countries: [], relocation: { open: true, countries: ["NL", "DE", "IE"], needs_sponsorship: true }, languages: ["en"], tracks });
const remoteOnly = normalizeProfile({ home_country: "IT", modes: ["remote"], tracks, seniority_max: "senior", self_employed_ok: true });

const J = (o) => ({ title: "Product Manager", company: "Acme", location: "Milan, Italy", ...o });
const codes = r => r.reasons.map(x => x.code);

test("parseLocation reads modes, countries and regions", () => {
  assert.deepEqual(parseLocation("Remote - EMEA").regions, ["EMEA"]);
  assert.equal(parseLocation("Remote - EMEA").mode, "remote");
  const m = parseLocation("Milan, Italy (Hybrid)"); assert.equal(m.mode, "hybrid"); assert.deepEqual(m.countries, ["IT"]);
  assert.equal(parseLocation("Worldwide").worldwide, true);
  assert.deepEqual(parseLocation("Berlin or Remote Germany").countries, ["DE"]);
  assert.equal(parseLocation("Remote (US only)").countries[0], "US");
  assert.equal(parseLocation("Segrate, Lombardy, Italy").mode, "onsite");
  assert.equal(parseLocation("").mode, "unknown");
});

test("inScope: regions and countries", () => {
  assert.equal(inScope(parseLocation("Remote - EU"), "IT"), true);
  assert.equal(inScope(parseLocation("Remote - EU"), "EG"), false);
  assert.equal(inScope(parseLocation("Remote - EMEA"), "EG"), true);
  assert.equal(inScope(parseLocation("Remote - United States"), "IT"), false);
  assert.equal(inScope(parseLocation("Remote"), "IT"), null);
});

test("detectors", () => {
  assert.equal(detectSeniority("Senior Data Analyst"), "senior");
  assert.equal(detectSeniority("Junior QA Engineer"), "junior");
  assert.equal(detectSeniority("Head of Product"), "lead");
  assert.equal(detectSeniority("Product Manager"), "mid");
  assert.equal(detectEmployment({ title: "Marketing Intern" }).value, "internship");
  assert.equal(detectEmployment({ title: "Data Analyst (Partita IVA)" }).value, "freelance");
  assert.deepEqual(detectLanguages("Fluent Italian required"), ["it"]);
  assert.deepEqual(detectLanguages("Customer Success w/ German"), ["de"]);
  assert.deepEqual(detectLanguages("We use Italian marble in our offices"), []);
});

test("student on a 20h permit: full-time explicit is blocked, part-time and internships are fine", () => {
  const full = evaluate(J({ employment: "full_time" }), student);
  assert.equal(full.verdict, "no"); assert.ok(codes(full).includes("full_time_limit"));
  const part = evaluate(J({ employment: "part_time" }), student);
  assert.equal(part.verdict, "fit");
  const intern = evaluate(J({ title: "Product Manager Intern", employment: "internship" }), student);
  assert.equal(intern.verdict, "fit");
});

test("student: unlabelled full-time is a check, not a block", () => {
  const r = evaluate(J({}), student);
  assert.equal(r.verdict, "check"); assert.ok(codes(r).includes("hours_unclear"));
});

test("on-site abroad is blocked, remote that accepts Italy is a plus", () => {
  const berlin = evaluate(J({ location: "Berlin, Germany", employment: "part_time" }), student);
  assert.equal(berlin.verdict, "no"); assert.ok(codes(berlin).includes("wrong_country"));
  const rem = evaluate(J({ location: "Remote - Europe", employment: "part_time" }), student);
  assert.equal(rem.verdict, "fit"); assert.ok(codes(rem).includes("remote_ok"));
});

test("remote limited to other countries is blocked; unknown region is a check", () => {
  const us = evaluate(J({ location: "Remote (United States)", employment: "part_time" }), student);
  assert.equal(us.verdict, "no"); assert.ok(codes(us).includes("remote_not_for_you"));
  const unk = evaluate(J({ location: "Remote", employment: "part_time" }), student);
  assert.equal(unk.verdict, "check"); assert.ok(codes(unk).includes("remote_region_unknown"));
});

test("relocator needing sponsorship: abroad on-site is a check, 'no sponsorship' blocks it", () => {
  const ams = evaluate(J({ location: "Amsterdam, Netherlands" }), relocator);
  assert.equal(ams.verdict, "check"); assert.ok(codes(ams).includes("needs_relocation")); assert.ok(codes(ams).includes("sponsorship_unknown"));
  const ok = evaluate(J({ location: "Amsterdam, Netherlands", sponsorship: true }), relocator);
  assert.equal(ok.verdict, "check"); assert.ok(codes(ok).includes("sponsorship"));
  const no = evaluate(J({ location: "Amsterdam, Netherlands", sponsorship: false }), relocator);
  assert.equal(no.verdict, "no"); assert.ok(codes(no).includes("no_sponsorship"));
  const us = evaluate(J({ location: "Austin, United States" }), relocator);
  assert.equal(us.verdict, "no");
});

test("language, seniority, salary, exclusions", () => {
  assert.ok(codes(evaluate(J({ title: "Product Manager (fluent German required)", location: "Remote - Europe" }), remoteOnly)).includes("language"));
  assert.ok(codes(evaluate(J({ title: "Senior Product Manager" }), student)).includes("seniority"));
  const sal = normalizeProfile({ ...remoteOnly, salary_floor: { amount: 40000, currency: "EUR", period: "year" }, tracks });
  assert.ok(codes(evaluate(J({ location: "Remote - Worldwide", salary: { min: 20, max: 25, currency: "EUR", period: "hour" } }), sal)).includes("salary_ok"));
  assert.ok(codes(evaluate(J({ location: "Remote - Worldwide", salary: { min: 1500, max: 2000, currency: "EUR", period: "month" } }), sal)).includes("salary_low"));
  const ex = normalizeProfile({ ...remoteOnly, excluded_companies: ["acme"], tracks });
  assert.equal(evaluate(J({ location: "Remote" }), ex).verdict, "no");
});

test("freelance contracts follow the self-employed setting and warn about permits", () => {
  assert.ok(codes(evaluate(J({ title: "Product Manager (P.IVA)", employment: "freelance" }), student)).includes("no_freelance"));
  const sp = normalizeProfile({ ...student, self_employed_ok: true, tracks });
  assert.ok(codes(evaluate(J({ title: "Product Manager (P.IVA)", employment: "freelance" }), sp)).includes("permit_selfemployment"));
});

test("tracks decide what is relevant and which CV to suggest", () => {
  const r = evaluate(J({ title: "Test Automation Engineer", location: "Remote - Worldwide", employment: "part_time" }), student);
  assert.equal(r.track.cv, "QA CV");
  const off = evaluate(J({ title: "Warehouse Operator", location: "Remote - Worldwide" }), student);
  assert.ok(codes(off).includes("off_track"));
});

test("describeProfile is human readable", () => {
  const t = describeProfile(student);
  assert.match(t, /20 hours a week/); assert.match(t, /IT/);
});

test("'Anywhere in France' is not worldwide, unpaid roles are blocked", () => {
  const p = parseLocation("Anywhere in France"); assert.equal(p.worldwide, false); assert.deepEqual(p.countries, ["FR"]); assert.equal(p.mode, "remote");
  assert.equal(inScope(p, "IT"), false);
  assert.ok(codes(evaluate(J({ title: "Product Owner (Volunteer, unpaid)", location: "Remote - Worldwide" }), student)).includes("unpaid"));
});
