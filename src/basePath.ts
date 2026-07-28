/**
 * Deploy-base helpers.
 *
 * The app can be hosted at the root or under a subpath (`VITE_BASE=/vrm/`), so
 * every root-relative path the app produces or accepts has to be resolved
 * against `import.meta.env.BASE_URL`. Absolute `/…` strings that skip this are
 * the classic subpath-deploy bug: they work in dev and 404 in production.
 */

/** The deploy base, always with a trailing slash. */
export function basePath(): string {
  const value = import.meta.env.BASE_URL || '/';
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Resolves a root-relative path against the deploy base. Absolute URLs, data
 * URIs, and blob URLs are returned untouched.
 */
export function withBase(pathOrUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl) || pathOrUrl.startsWith('//')) return pathOrUrl;

  const base = basePath();
  if (!pathOrUrl.startsWith('/')) return `${base}${pathOrUrl}`;
  // Already base-prefixed (e.g. a URL copied out of the address bar).
  if (base !== '/' && pathOrUrl.startsWith(base)) return pathOrUrl;
  return `${base}${pathOrUrl.slice(1)}`;
}
