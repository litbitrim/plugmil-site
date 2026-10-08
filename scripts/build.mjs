import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const output = new URL('public/', root);
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'contact.js', 'plugmil-akquise.html']) {
  await copyFile(new URL(file, root), new URL(file, output));
}
await writeFile(new URL('robots.txt', output), 'User-agent: *\nAllow: /\nSitemap: https://plugmil.dev/sitemap.xml\n');
await writeFile(new URL('sitemap.xml', output), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://plugmil.dev/</loc></url></urlset>\n');
console.log(`Static site built: ${fileURLToPath(output)}`);
