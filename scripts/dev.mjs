import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createContactHandler } from '../lib/contact.mjs';
const env = { ...process.env, CONTACT_LOCAL_DEV: '1' };
const contact = createContactHandler({ env });
const allowedFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/contact.js', ['contact.js', 'text/javascript; charset=utf-8']],
  ['/plugmil-akquise.html', ['plugmil-akquise.html', 'text/html; charset=utf-8']],
]);
http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1:4173').pathname;
  if (path === '/api/contact') return contact(req, res);
  const file = allowedFiles.get(path);
  if (!file || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Seite nicht gefunden');
  }
  try {
    const body = await readFile(new URL(`../${file[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': file[1], 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500);
    res.end('Datei nicht verfügbar');
  }
}).listen(4173, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:4173'));
