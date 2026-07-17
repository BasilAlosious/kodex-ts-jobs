# Kodex — Trust & Safety Jobs Board (MVP)

An auto-refreshed board of Trust & Safety, compliance, and policy roles aggregated
from company career boards. Built with Astro; designed to mount on kodexglobal.com
via Webflow Cloud.

## Run it

```sh
npm install
npm run ingest   # pulls live jobs from ATS APIs → src/data/jobs.json
npm run dev      # http://localhost:4321
```

## How it works

1. **Ingestion** (`scripts/ingest.mjs`) pulls every open role from a curated
   watch list of companies via their public ATS APIs (Greenhouse + Ashby;
   Lever adapter included). No keys or scraping needed for these sources.
2. **Filtering** narrows thousands of open roles to T&S: include-keyword rules
   (trust & safety, moderation, policy, compliance, investigations, fraud/risk,
   law enforcement response…) minus negative rules (pure engineering, sales,
   credit/market risk…). Roles get a category, dedupe hash, and first/last-seen
   timestamps.
3. **Frontend** renders a filterable index plus one static page per job with
   `JobPosting` JSON-LD for search engines. Apply links go to the company's
   official careers page.

Current numbers: ~2,600 open roles across 15 watched companies → ~105 T&S roles.

## MVP shortcuts (vs. the production plan)

- **Data store:** local `src/data/jobs.json` instead of Sanity. Production writes
  jobs as `pending` documents to Sanity for human review before publish.
- **Publish flow:** auto-publish. Production adds the review gate.
- **Refresh:** manual `npm run ingest`. Production runs it on a weekly cron
  (GitHub Action) with stale-job expiry.
- **Deploy:** local dev server. Production adds the Cloudflare adapter and mounts
  at `kodexglobal.com/trust-and-safety-jobs` via Webflow Cloud.

## Editing the watch list

Add companies to `SOURCES` in `scripts/ingest.mjs` with their ATS and board slug.
Tune the include/exclude rules in the same file.
