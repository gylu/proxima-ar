import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist/pages');
const source = path.join(root, 'web');
const origin = new URL(process.env.PROXIMA_PUBLIC_API_ORIGIN || '');
if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/' || !origin.hostname.endsWith('.run.app'))
  throw new Error('Set PROXIMA_PUBLIC_API_ORIGIN to the public HTTPS gateway origin.');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
async function copyAssets(from, to) {
  for (const item of await readdir(from, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const src = path.join(from, item.name), dest = path.join(to, item.name);
    if (item.isDirectory() && ['assets','vendor'].includes(item.name)) {
      await mkdir(dest); await copyAssets(src, dest);
    } else if (item.isFile() && /\.(?:html|css|js|mjs|woff2|svg|webp|txt)$/.test(item.name)) {
      await cp(src, dest);
    } else throw new Error('Unexpected public asset: ' + item.name);
  }
}
await copyAssets(source, out);
const page = path.join(out, 'index.html');
const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' " + origin.origin + "; object-src 'none'; base-uri 'none'; form-action 'self'";
await writeFile(page, (await readFile(page, 'utf8')).replace('<head>', '<head>\n    <meta name="proxima-api-origin" content="' + origin.origin + '" />\n    <meta name="referrer" content="no-referrer" />\n    <meta http-equiv="Content-Security-Policy" content="' + policy + '" />'));
await writeFile(path.join(out, '.nojekyll'), '');
console.log('Built the public frontend in dist/pages.');
