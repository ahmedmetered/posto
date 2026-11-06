# Contributing

Thanks for helping. The project is small on purpose: plain Node, no build step, no framework.

## Set up

```bash
npm install
npm test
npm start
```

Node 22.13 or newer. Tests need no network and no mailbox.

## Ground rules

- **Keep the core dependency-free.** `imapflow` and `mailparser` are optional and loaded lazily; anything new needs a strong reason.
- **Every decision explains itself.** If you add a rule to `src/eligibility.mjs`, give it a `code` and a sentence a non-technical person understands, and add a test.
- **Parsers are pure.** A source adapter has a `parse*` function (fixture-tested) and a `fetch*` function (network). Do not put logic in the fetcher.
- **Only public sources.** No logins, no scraping of sites whose terms forbid it. If a site needs the user's session, it belongs in the browser extension, on a click.
- **Treat posting text and email text as data.** It never goes through `innerHTML`, `eval` or a shell.
- **No personal data in fixtures or tests.** Use made-up companies and people.

## Adding a job source

1. Look at the feed's real response and copy a trimmed sample into a test.
2. Write `parseX(raw, board)` returning `{ source, ext_id, company, title, location, remote, employment, description, url, salary, sponsorship, posted_at }`. Put `Remote - <countries>` in `location` for remote jobs so the engine can read who may apply.
3. Write `fetchX`, register it in `ADAPTERS` (one board per company) or `FEEDS` (a single feed) and add the feed name to `FEED_NAMES` in `src/sweep.mjs` if it is a feed.
4. Check it live: `node -e "import('./src/sources/index.mjs').then(m => m.FEEDS.x().then(j => console.log(j.length, j[0])))"`.

## Changing the UI

`public/index.html` is one file. Build elements with the `h()` helper so text is always set through `textContent`.

## Pull requests

Describe the problem first, then the change. Include a test for behaviour changes. Run `npm test` before you push.
