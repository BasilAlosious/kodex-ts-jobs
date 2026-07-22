# Kodex — Trust & Safety Jobs Board

An auto-refreshed board of Trust & Safety, law-enforcement-response, and
financial-crime roles aggregated from company career boards. Astro frontend,
Sanity backend, weekly ingestion via GitHub Actions.

## Architecture

```
GitHub Action (Mondays 08:00 UTC, or manual dispatch)
  └─ scripts/ingest.mjs
       ├─ pulls all open roles from watched companies
       │    Greenhouse GET /v1/boards/{token}/jobs
       │    Lever      GET /v0/postings/{token}?mode=json
       │    Ashby      GET /posting-api/job-board/{token}
       │    Workday    POST /wday/cxs/{tenant}/{site}/jobs (paginated, 20/page)
       ├─ filters titles: INCLUDE regex minus EXCLUDE regex (see ingest.mjs)
       ├─ upserts to Sanity by dedupeHash (firstSeen preserved)
       └─ expires published roles that vanished from a fetched board
  └─ hits Vercel deploy hook → static rebuild

Astro build pulls published jobs from Sanity (GROQ) → static pages on Vercel.
```

## Moderation (Sanity Studio)

Studio: **https://kodex-ts-jobs.sanity.studio/** (project `w6xju9i2`, dataset `production`).

Jobs auto-publish on ingest. Moderate after the fact by setting `status`:

| Status | Meaning |
|---|---|
| `published` | Live on the board (default for every ingested role) |
| `expired` | Auto-set when the role disappears from the company's board; re-publishes if it reappears |
| `killed` | Manually removed. Ingestion **never** resurrects a killed job |

You can also edit titles/categories in Studio; note ingestion overwrites edited
fields on published jobs at the next run (kill instead if a role shouldn't be listed).

## Run locally

```sh
npm install
# .env needs SANITY_PROJECT_ID, SANITY_DATASET, SANITY_WRITE_TOKEN (see 1Password/handoff)
node scripts/ingest.mjs        # ingest → Sanity
node scripts/ingest.mjs --local # …and also write src/data/jobs.json for debugging
npm run dev                    # board at localhost:4321
npm run build                  # static build (pulls from Sanity)
```

## Watched companies

Edit `SOURCES` in `scripts/ingest.mjs`. Workday entries need `{tenant, wdN, site}`
from the company careers URL (e.g. `tmobile.wd1.myworkdayjobs.com/External`
→ `{ tenant: 'tmobile', wdN: 1, site: 'External' }`).

## CI secrets (GitHub repo settings)

- `SANITY_WRITE_TOKEN` — editor token for the ingest script (required)
- `VERCEL_DEPLOY_HOOK_URL` — Vercel deploy hook to rebuild after ingest (optional;
  create under Vercel → Project → Settings → Git → Deploy Hooks)

## Design

Linear-style system (see `DESIGN-linear.app.md` in the project docs): near-black
`#010102` canvas, surface ladder with hairline borders, single lavender accent
`#5e6ad2`, Inter with negative display tracking.
