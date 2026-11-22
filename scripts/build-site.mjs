import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const frontend = path.join(root, 'web');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};
const assets = {};
for (const directory of ['', 'assets', 'vendor']) {
  for (const entry of (await readdir(path.join(frontend, directory), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const type = types[path.extname(entry.name)];
    if (!type) throw new Error('Unexpected frontend asset type in ' + entry.name);
    const name = path.posix.join(directory, entry.name);
    assets['/' + name] = [type, (await readFile(path.join(frontend, name))).toString('base64')];
  }
}
const worker = await readFile(path.join(root, 'worker/site.mjs'), 'utf8');
await mkdir(path.join(dist, 'server'), { recursive: true });
await writeFile(
  path.join(dist, 'server/index.js'),
  worker +
    '\nconst assets=' +
    JSON.stringify(assets) +
    ';\nexport default {fetch(request,env){return serveSite(request,env,assets);}};\n',
);
console.log('Built private Site with ' + Object.keys(assets).length + ' frontend assets.');
