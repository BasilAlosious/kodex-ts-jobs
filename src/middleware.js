// Webflow Cloud's edge canonicalizes the mount path to NO trailing slash
// before forwarding, but Astro only matches the base root with the slash
// (`/mount/`). Rewrite the bare mount path internally so it renders instead
// of 404ing. Deep routes match either form already.

export function onRequest(context, next) {
  const root = import.meta.env.BASE_URL.replace(/\/$/, '');
  if (root) {
    const url = new URL(context.request.url);
    if (url.pathname === root) {
      return context.rewrite(`${root}/`);
    }
  }
  return next();
}
