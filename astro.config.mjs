import { defineConfig } from 'astro/config';

// MVP runs at root. When mounted on Webflow Cloud, set base to the mount
// path (e.g. '/trust-and-safety-jobs') and add the Cloudflare adapter.
export default defineConfig({
  site: 'https://kodexglobal.com',
});
