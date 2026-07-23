// Ingestion: pull jobs from public ATS APIs for the watched company list,
// filter to Trust & Safety / LE-response roles per Kodex's include/exclude
// spec, normalize, dedup, and upsert into Sanity.
//
//   node scripts/ingest.mjs            → writes to Sanity (needs .env / env vars)
//   node scripts/ingest.mjs --local    → also writes src/data/jobs.json (dev)
//
// Status lifecycle in Sanity:
//   published → live on the board (default for every ingested role)
//   expired   → auto-set when a role disappears from a successfully-fetched board
//   killed    → set by a human in Studio; ingestion never resurrects killed jobs

import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_OUT = join(ROOT, 'src/data/jobs.json');
const WRITE_LOCAL = process.argv.includes('--local');

// Minimal .env loader (no deps).
try {
  const env = await readFile(join(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* rely on real env vars (CI) */ }

const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID || 'w6xju9i2';
const SANITY_DATASET = process.env.SANITY_DATASET || 'production';
const SANITY_TOKEN = process.env.SANITY_WRITE_TOKEN;
const SANITY_API = `https://${SANITY_PROJECT_ID}.api.sanity.io/v2024-01-01`;

// ---------------------------------------------------------------------------
// Watched companies. Add entries here — this is the whole "source list".
// workday entries need { tenant, wdN, site } from the company's careers URL.
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
  { ats: 'ashby', slug: 'openai', company: 'OpenAI' },
  { ats: 'ashby', slug: 'ramp', company: 'Ramp' },
  { ats: 'ashby', slug: 'notion', company: 'Notion' },
  { ats: 'ashby', slug: 'sardine', company: 'Sardine' },
  { ats: 'ashby', slug: 'persona', company: 'Persona' },
  { ats: 'ashby', slug: 'cinder', company: 'Cinder' },
  { ats: 'workday', tenant: 'tmobile', wdN: 1, site: 'External', company: 'T-Mobile' },
  { ats: 'workday', tenant: 'verizon', wdN: 12, site: 'verizon-careers', company: 'Verizon' },
  { ats: 'workday', tenant: 'comcast', wdN: 5, site: 'Comcast_Careers', company: 'Comcast' },
  { ats: 'workday', tenant: 'paypal', wdN: 1, site: 'jobs', company: 'PayPal' },
];

// ---------------------------------------------------------------------------
// Kodex filter spec (John, 2026-07). INCLUDE terms are ORed; "abuse/fraud/
// threat investigat" = any of those words within reach of "investigat";
// "BSA/AML" = either token, word-bounded. EXCLUDE wins over INCLUDE.
// ---------------------------------------------------------------------------
const INCLUDE = new RegExp(
  [
    'law enforcement',
    'subpoena',
    'disclosure',
    'legal process',
    'records request',
    '\\bLERT\\b',
    'financial crime',
    'insider risk',
    'investigator',
    '(abuse|fraud|threat).{0,24}investigat',
    'trust (and|&) safety',
    'platform integrity',
    'content moderation',
    '\\b(BSA|AML)\\b',
    'sanctions',
  ].join('|'),
  'i',
);

const EXCLUDE = /software engineer|data scientist|designer|developer|counsel|attorney/i;

const CATEGORY_RULES = [
  { cat: 'Law Enforcement Response', re: /law enforcement|subpoena|disclosure|legal process|records request|\bLERT\b/i },
  { cat: 'Financial Crime & AML', re: /financial crime|\b(BSA|AML)\b/i },
  { cat: 'Sanctions', re: /sanctions/i },
  { cat: 'Insider Risk', re: /insider risk/i },
  { cat: 'Content Moderation', re: /content moderation|moderat/i },
  { cat: 'Trust & Safety', re: /trust (and|&) safety|platform integrity/i },
  { cat: 'Investigations', re: /investigat/i },
];

const categorize = (title) =>
  (CATEGORY_RULES.find(({ re }) => re.test(title)) || { cat: 'Trust & Safety' }).cat;

const isMatch = (title) => INCLUDE.test(title) && !EXCLUDE.test(title);

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const looksRemote = (location) => /remote|anywhere|distributed/i.test(location || '');

const dedupeHash = (job) =>
  createHash('sha1')
    .update([job.company, job.title, job.location, job.applyUrl].join('|').toLowerCase())
    .digest('hex')
    .slice(0, 12);

// ---------------------------------------------------------------------------
// Adapters — each returns [{ title, location, applyUrl, postedAt, excerpt, description }]
// ---------------------------------------------------------------------------
async function fetchJson(url, init) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...init?.headers }, ...init });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Turn ATS description HTML into clean plaintext with paragraph breaks.
// Handles double-encoded entities (Greenhouse ships `&lt;h2&gt;` in JSON).
const DESC_CAP = 2500;
function htmlToText(html) {
  if (!html) return '';
  const decode = (t) =>
    t
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&rsquo;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  let s = decode(String(html));
  s = s.replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '');
  s = decode(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > DESC_CAP ? s.slice(0, DESC_CAP).replace(/\s+\S*$/, '') + '…' : s;
}

const adapters = {
  async greenhouse({ slug }) {
    const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return (data.jobs || []).map((j) => ({
      title: j.title,
      location: j.location?.name || '',
      applyUrl: j.absolute_url,
      postedAt: j.updated_at || null,
      excerpt: '',
      description: htmlToText(j.content),
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
      description: htmlToText(j.descriptionPlain || j.description),
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
      description: htmlToText(j.descriptionPlain || j.descriptionHtml),
    }));
  },
  // POST + offset pagination per Kodex spec; capped to stay polite on the
  // giant boards (T-Mobile lists ~2k roles).
  async workday({ tenant, wdN, site }) {
    const base = `https://${tenant}.wd${wdN}.myworkdayjobs.com`;
    const url = `${base}/wday/cxs/${tenant}/${site}/jobs`;
    const out = [];
    const LIMIT = 20; // Workday hard-caps page size at 20
    const MAX = 2400;
    let total = Infinity; // only the offset=0 response carries a real total
    for (let offset = 0; offset < Math.min(total, MAX); offset += LIMIT) {
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: LIMIT, offset, searchText: '', appliedFacets: {} }),
      });
      if (offset === 0 && Number.isFinite(data.total) && data.total > 0) total = data.total;
      const page = data.jobPostings || [];
      if (page.length === 0) break;
      for (const j of page) {
        if (!j.title || !j.externalPath) continue;
        out.push({
          title: j.title,
          location: j.locationsText || '',
          applyUrl: `${base}/en-US/${site}${j.externalPath.startsWith('/') ? '' : '/'}${j.externalPath.replace(/^\/[^/]+/, '')}`,
          postedAt: null, // Workday exposes "Posted N days ago" text only
          excerpt: j.postedOn || '',
          description: '', // not available in the Workday list endpoint
        });
      }
      if (page.length < LIMIT) break;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Sanity helpers (plain HTTP, no client dependency)
// ---------------------------------------------------------------------------
async function sanityQuery(groq) {
  const res = await fetchJson(`${SANITY_API}/data/query/${SANITY_DATASET}?query=${encodeURIComponent(groq)}`, {
    headers: SANITY_TOKEN ? { authorization: `Bearer ${SANITY_TOKEN}` } : {},
  });
  return res.result;
}

async function sanityMutate(mutations) {
  const CHUNK = 100;
  for (let i = 0; i < mutations.length; i += CHUNK) {
    const res = await fetch(`${SANITY_API}/data/mutate/${SANITY_DATASET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SANITY_TOKEN}` },
      body: JSON.stringify({ mutations: mutations.slice(i, i + CHUNK) }),
    });
    if (!res.ok) throw new Error(`Sanity mutate failed: ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
async function run() {
  if (!SANITY_TOKEN) {
    console.error('SANITY_WRITE_TOKEN missing (set it in .env or CI secrets)');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const existing = await sanityQuery(
    '*[_type == "job"]{_id, dedupeHash, firstSeen, status, company}',
  );
  const byHash = new Map(existing.map((d) => [d.dedupeHash, d]));

  const jobs = [];
  const stats = [];
  const succeededCompanies = new Set();

  for (const source of SOURCES) {
    try {
      const raw = await adapters[source.ats](source);
      const matched = raw.filter((j) => j.title && j.applyUrl && isMatch(j.title));
      succeededCompanies.add(source.company);
      stats.push(`${source.company.padEnd(12)} ${source.ats.padEnd(10)} ${String(raw.length).padStart(4)} open → ${matched.length} match`);
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
          description: j.description || '',
        };
        job.dedupeHash = dedupeHash(job);
        job.slug = `${slugify(source.company)}-${slugify(j.title)}-${job.dedupeHash.slice(0, 6)}`;
        jobs.push(job);
      }
    } catch (err) {
      stats.push(`${source.company.padEnd(12)} ${source.ats.padEnd(10)} FAILED: ${err.message}`);
    }
  }

  // Dedup within the run.
  const seen = new Set();
  const deduped = jobs.filter((j) => (seen.has(j.dedupeHash) ? false : seen.add(j.dedupeHash)));

  // Upsert. killed docs are left untouched entirely; expired docs that
  // reappear flip back to published.
  const mutations = [];
  let created = 0, updated = 0, skippedKilled = 0;
  for (const job of deduped) {
    const prev = byHash.get(job.dedupeHash);
    if (prev?.status === 'killed') { skippedKilled++; continue; }
    mutations.push({
      createOrReplace: {
        _id: `job-${job.dedupeHash}`,
        _type: 'job',
        ...job,
        firstSeen: prev?.firstSeen || now,
        lastSeen: now,
        status: 'published',
      },
    });
    prev ? updated++ : created++;
  }

  // Expire published jobs that vanished from a board we successfully fetched.
  const liveHashes = new Set(deduped.map((j) => j.dedupeHash));
  let expired = 0;
  for (const doc of existing) {
    if (doc.status === 'published' && !liveHashes.has(doc.dedupeHash) && succeededCompanies.has(doc.company)) {
      mutations.push({ patch: { id: doc._id, set: { status: 'expired', lastSeen: now } } });
      expired++;
    }
  }

  await sanityMutate(mutations);

  if (WRITE_LOCAL) {
    await writeFile(LOCAL_OUT, JSON.stringify({ generatedAt: now, jobs: deduped.map((j) => ({ ...j, firstSeen: byHash.get(j.dedupeHash)?.firstSeen || now, lastSeen: now, status: 'published' })) }, null, 2));
  }

  console.log(stats.join('\n'));
  console.log(`\nSanity: ${created} created, ${updated} updated, ${expired} expired, ${skippedKilled} kept killed`);
}

run();
