# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Existing codebase: plain Node server, one static `public/index.html` (vanilla JS, no framework, no build step). Keep it that way.

## Users
Job seekers on their own computer, in very different situations: a student with a 20-hour work permit, someone relocating who needs visa sponsorship, a remote-only freelancer. They open it daily, often while stressed, to see what is worth applying to and where their applications stand. Inferred from the build conversation, not interviewed.

## Product Purpose
Finds jobs the person can actually apply to given their real constraints, explains every in/out decision in plain words, tracks applications and replies (reads the inbox), compares CVs to postings, optional AI tailoring. Local-first and open source, shown in the author's portfolio.

## Positioning
Every verdict carries its reason ("remote, but only for US residents"). Job boards filter by keyword; this filters by the person's situation and shows its work.

## Operating Context
Daily check-in: Today feed (fit / check first), Tracker (status columns, reply threads), Insights, a situation profile form, Settings (CVs, mailbox, sweep schedule, AI, sources, extension). Runs at localhost.

## Capabilities and Constraints
Views: sign in, Today, Tracker, Insights, My situation, Settings. Single HTML file, text set via textContent (no innerHTML), must stay dependency-free. Product name undecided (working title "Job search agent"); brand must be one swappable token.

## Brand Commitments
Name pending. Open source, portfolio piece: should look unmistakably designed, not a template. The previous Apple-style look is rejected as too generic.

## Evidence on Hand
No logos, testimonials or screenshots. Demo data comes from the live sweep.

## Product Principles
1. Show the reason behind every decision.
2. The person's situation, not a keyword, is the unit of search.
3. Calm under stress: never shame a rejection, never hide the next action.
4. Local and honest: nothing leaves the machine without a click.
