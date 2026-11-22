// GitHub Pages supplies the public gateway origin at build time. The original
// same-origin host continues to work with the source HTML.
const origin = document.querySelector('meta[name="proxima-api-origin"]')?.content || location.origin;
export const publicDemo = origin !== location.origin;
export function apiFetch(path, options = {}) {
  return fetch(new URL('/api/' + path, origin), {
    ...options, credentials: publicDemo ? 'omit' : 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
  });
}
