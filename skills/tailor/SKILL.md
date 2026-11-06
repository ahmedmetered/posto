---
name: posto-tailor
description: >
  Tailor a CV, write a short cover letter, or list the honest gaps for one job posting, grounded only in the
  candidate's own CV. Use when the user pastes a Posto brief, or asks to "tailor my CV for this job",
  "write a cover letter" or "what is missing from my CV for this". Writes text only; the user decides what to send.
license: MIT
metadata:
  origin: Method adapted from ai-job-search by Mads Lorentzen (MIT), via anyjobsearch.
---

# Posto tailoring (agent skill)

Posto compares your CVs with each posting without any AI. When you want writing help but would rather use the agent you
already have than add an API key, this skill is the other half.

## The loop

1. In Posto, open a job and press **Brief: tailor my CV**, **Brief: cover letter** or **Brief: what is missing**.
   The brief holds the posting, the CV that covers it best and the rules.
2. Give the brief to your agent. Follow `references/tailoring.md`.
3. Read the result before using it. Anything the posting asks for that the CV does not show must be flagged, not claimed.

## Hard rules

- Use only what is in the CV. Never invent an employer, date, number, degree, skill or result.
- Mirror the posting's vocabulary only where it is true.
- Never submit an application. The candidate sends it, after confirming that single application.
