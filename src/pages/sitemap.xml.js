// SSR sitemap served at <mount>/sitemap.xml. Lists the board index + every
// published job detail page with absolute URLs on the www host + mount path,
// so it can be submitted directly in Google Search Console (the Webflow-managed
// sitemap doesn't cover Webflow Cloud app pages).
import { getJobs } from '../lib/jobs.js';

export async function GET({ site }) {
  const root = import.meta.env.BASE_URL.replace(/\/$/, '');
  const abs = (path) => new URL(path, site).href;
  const { jobs } = await getJobs();
  const now = new Date().toISOString();

  const urls = [
    { loc: abs(root || '/'), changefreq: 'daily', priority: '1.0', lastmod: now },
    ...jobs.map((job) => ({
      loc: abs(`${root}/jobs/${job.slug}`),
      changefreq: 'weekly',
      priority: '0.7',
      lastmod: job.lastSeen || job.firstSeen || now,
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`,
  )
  .join('\n')}
</urlset>`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
