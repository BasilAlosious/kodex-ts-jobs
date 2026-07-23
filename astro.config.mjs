import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// Webflow Cloud serves the app from a mount path (e.g. /trust-and-safety-jobs)
// and injects it as CLOUD_MOUNT_PATH at build time. Locally it's unset → root.
// All pages are prerendered (content comes from Sanity at build time), so the
// Cloudflare worker just serves static output.
// Normalize to exactly one trailing slash so BASE_URL joins cleanly with
// manual hrefs (Webflow may inject the mount path with or without a slash).
const base = `/${(process.env.CLOUD_MOUNT_PATH || '').replace(/^\/|\/$/g, '')}/`.replace(/\/\/+/g, '/');

export default defineConfig({
  site: 'https://kodexglobal.com',
  base,
  // Webflow Cloud canonicalizes the mount path to NO trailing slash (301).
  // Match that so we don't fight it into a redirect loop.
  trailingSlash: 'never',
  output: 'server',
  adapter: cloudflare({ platformProxy: { enabled: true } }),
  compressHTML: true,
});
