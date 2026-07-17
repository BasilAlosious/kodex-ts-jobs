// Ingestion: pull jobs from public ATS APIs for the seed company list,
// keyword-filter to Trust & Safety roles, normalize, dedup, and write
// src/data/jobs.json. Run with: npm run ingest
//
// MVP stores to local JSON; the production version writes to Sanity as
// "pending" documents for human review before publish.

import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/data/jobs.json');

// ---------------------------------------------------------------------------
// Seed sources. John's list replaces/extends this — every entry is a company
// board we watch weekly, not a blanket scrape.
// ---------------------------------------------------------------------------
const SOURCES = [
  { ats: 'greenhouse', slug: 'discord', company: 'Discord' },
  { ats: 'greenhouse', slug: 'reddit', company: 'Reddit' },
  { ats: 'greenhouse', slug: 'coinbase', company: 'Coinbase' },
  { ats: 'greenhouse', slug: 'stripe', company: 'Stripe' },
  { ats: 'greenhouse', slug: 'roblox', company: 'Roblox' },
  { ats: 'greenhouse', slug: 'twitch', company: 'Twitch' },
  { ats: 'greenhouse', slug: 'robinhood', company: 'Robinhood' },
  { ats: 'greenhouse', slug: 'pinterest', company: 'Pinterest' },
  { ats: 'greenhouse', slug: 'duolingo', company: 'Duolingo' },
  { ats: 'ashby', slug: 'openai', company: 'OpenAI' },
  { ats: 'ashby', slug: 'ramp', company: 'Ramp' },
  { ats: 'ashby', slug: 'notion', company: 'Notion' },
  { ats: 'ashby', slug: 'sardine', company: 'Sardine' },
  { ats: 'ashby', slug: 'persona', company: 'Persona' },
  { ats: 'ashby', slug: 'cinder', company: 'Cinder' },
];

// ---------------------------------------------------------------------------
// Stage 2 filtering: what counts as a T&S role.
// ---------------------------------------------------------------------------
const INCLUDE = [
  /trust\s*(&|and)?\s*safety/i,
  /\bcontent (moderat|policy|review)/i,
  /\bmoderat(ion|or)/i,
  /\bplatform (integrity|policy|abuse)/i,
  /\b(fraud|abuse|risk) (analyst|investigat|operations|ops|specialist|manager|lead)/i,
  /\bcompliance\b/i,
  /\blaw enforcement (response|relations|outreach)/i,
  /\bpolicy (enforcement|specialist|manager|analyst|lead)/i,
  /\binvestigat(or|ions)\b/i,
  /\bsanctions\b/i,
  /\b(aml|bsa|kyc)\b/i,
  /\bchild safety\b/i,
  /\bthreat (intelligence|analyst|investigat)/i,
  /\bintegrity\b/i,
  /\bregulatory\b/i,
  /\blegal operations\b/i,
];

// Roles the keywords over-catch: pure engineering, sales, finance-risk, etc.
const EXCLUDE = [
  /\b(software|backend|frontend|full[- ]?stack|machine learning|ml|data|infrastructure|platform|site reliability|security) engineer/i,
  /\bengineering manager/i,
  /\b(account|sales) (executive|manager|director)/i,
  /\bcredit risk\b/i,
  /\bmarket risk\b/i,
  /\btax\b/i,
  /\baccountant\b/i,
  /\bhardware\b/i,
];

const CATEGORY_RULES = [
  { cat: 'Trust & Safety Ops', re: /trust\s*(&|and)?\s*safety|platform (integrity|abuse)|\bintegrity\b/i },
  { cat: 'Content Moderation', re: /moderat|content (review|policy)|child safety/i },
  { cat: 'Policy', re: /\bpolicy\b/i },
  { cat: 'Law Enforcement Response', re: /law enforcement|\bsubpoena|\ble (response|relations)\b/i },
  { cat: 'Fraud & Risk', re: /fraud|abuse|risk|threat/i },
  { cat: 'Compliance', re: /compliance|sanctions|\baml\b|\bbsa\b|\bkyc\b|regulatory|legal operations/i },
  { cat: 'Investigations', re: /investigat/i },
];

function categorize(title) {
  for (const { cat, re } of CATEGORY_RULES) if (re.test(title)) return cat;
  return 'Trust & Safety Ops';
}

function isTsRole(title) {
  return INCLUDE.some((re) => re.test(title)) && !EXCLUDE.some((re) => re.test(title));
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function dedupeHash(job) {
  return createHash('sha1')
    .update([job.company, job.title, job.location, job.applyUrl].join('|').toLowerCase())
    .digest('hex')
    .slice(0, 12);
}

function looksRemote(location) {
  return /remote|anywhere|distributed/i.test(location || '');
}

// ---------------------------------------------------------------------------
// Adapters — each returns [{ title, location, applyUrl, postedAt, excerpt }]
// ---------------------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const adapters = {
  async greenhouse({ slug }) {
    const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return (data.jobs || []).map((j) => ({
      title: j.title,
      location: j.location?.name || '',
      applyUrl: j.absolute_url,
      postedAt: j.updated_at || null,
      excerpt: '',
    }));
  },
  async ashby({ slug }) {
    const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return (data.jobs || []).map((j) => ({
      title: j.title,
      location: j.location || '',
      applyUrl: j.jobUrl || j.applyUrl,
      postedAt: j.publishedAt || null,
      excerpt: j.department ? `${j.department}${j.team && j.team !== j.department ? ` · ${j.team}` : ''}` : '',
    }));
  },
  async lever({ slug }) {
    const data = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (Array.isArray(data) ? data : []).map((j) => ({
      title: j.text,
      location: j.categories?.location || '',
      applyUrl: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      excerpt: j.categories?.team || '',
    }));
  },
};

// ---------------------------------------------------------------------------
async function run() {
  const now = new Date().toISOString();
  let previous = [];
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8')).jobs || [];
  } catch { /* first run */ }
  const previousByHash = new Map(previous.map((j) => [j.dedupeHash, j]));

  const jobs = [];
  const stats = [];

  for (const source of SOURCES) {
    try {
      const raw = await adapters[source.ats](source);
      const matched = raw.filter((j) => j.title && j.applyUrl && isTsRole(j.title));
      stats.push(`${source.company.padEnd(12)} ${source.ats.padEnd(10)} ${String(raw.length).padStart(4)} open → ${matched.length} T&S`);
      for (const j of matched) {
        const job = {
          company: source.company,
          title: j.title,
          location: j.location || 'Not specified',
          remote: looksRemote(j.location),
          roleCategory: categorize(j.title),
          applyUrl: j.applyUrl,
          source: source.ats,
          postedAt: j.postedAt,
          excerpt: j.excerpt,
        };
        job.dedupeHash = dedupeHash(job);
        const prev = previousByHash.get(job.dedupeHash);
        job.firstSeen = prev?.firstSeen || now;
        job.lastSeen = now;
        // MVP: auto-publish. Production: status starts "pending" in Sanity.
        job.status = prev?.status || 'published';
        job.slug = `${slugify(source.company)}-${slugify(j.title)}-${job.dedupeHash.slice(0, 6)}`;
        jobs.push(job);
      }
    } catch (err) {
      stats.push(`${source.company.padEnd(12)} ${source.ats.padEnd(10)} FAILED: ${err.message}`);
    }
  }

  // Dedup within this run (same role listed twice on one board).
  const seen = new Set();
  const deduped = jobs.filter((j) => (seen.has(j.dedupeHash) ? false : seen.add(j.dedupeHash)));

  deduped.sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''));

  await writeFile(OUT, JSON.stringify({ generatedAt: now, jobs: deduped }, null, 2));

  console.log(stats.join('\n'));
  console.log(`\n${deduped.length} T&S roles written to src/data/jobs.json`);
}

run();
