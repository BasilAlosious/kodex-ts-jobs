// Build-time fetch of published jobs from Sanity. Cached per build so the
// index and detail pages share one request.

const PROJECT_ID = import.meta.env.SANITY_PROJECT_ID || 'w6xju9i2';
const DATASET = import.meta.env.SANITY_DATASET || 'production';

const GROQ = `*[_type == "job" && status == "published"] | order(coalesce(postedAt, firstSeen) desc) {
  title, company, location, remote, roleCategory, applyUrl, source,
  postedAt, firstSeen, lastSeen, excerpt, description, slug, dedupeHash
}`;

// Per-isolate cache with a TTL: the worker serves from memory for a few
// minutes instead of hitting Sanity on every request, but fresh data (weekly
// ingest, Studio kills) shows up without a redeploy. Dev always refetches.
const TTL_MS = 10 * 60 * 1000;
let cache = null;
let cachedAt = 0;

export async function getJobs() {
  if (cache && import.meta.env.PROD && Date.now() - cachedAt < TTL_MS) return cache;
  const url = `https://${PROJECT_ID}.api.sanity.io/v2024-01-01/data/query/${DATASET}?query=${encodeURIComponent(GROQ)}`;
  const headers = { accept: 'application/json' };
  const token = import.meta.env.SANITY_READ_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Sanity query failed: ${res.status} ${await res.text()}`);
  const { result } = await res.json();
  cache = { generatedAt: new Date().toISOString(), jobs: result };
  cachedAt = Date.now();
  return cache;
}
