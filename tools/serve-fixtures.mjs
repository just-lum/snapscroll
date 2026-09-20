/* SnapScroll — 測試頁伺服器
 *
 *   node tools/serve-fixtures.mjs [--port 8788] [--open]
 *
 * 給手動驗證與 E2E 用的極簡靜態伺服器。用本機 http 而不是 file://，
 * 是因為擴充功能對 file:// 需要額外權限，而 http 頁面才是真實情境。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'fixtures');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8788;
const OPEN = argv.includes('--open');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filePath = path.join(FIXTURES, decodeURIComponent(url.pathname));

  if (!filePath.startsWith(FIXTURES)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    /* 沒有這個檔案時給一份目錄清單，省得去翻檔案總管 */
    const list = fs.readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.html'))
      .map((f) => `<li><a href="/${f}">${f}</a></li>`)
      .join('');
    res.writeHead(404, { 'content-type': TYPES['.html'] })
      .end(`<meta charset="utf-8"><h1>404</h1><ul>${list}</ul>`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`SnapScroll fixtures: ${base}`);
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));
  for (const f of files) console.log(`  ${base}/${f}`);
  if (OPEN) {
    /* 不引入 open 套件：直接叫系統的 start */
    import('node:child_process').then(({ spawn }) => {
      spawn('cmd', ['/c', 'start', '', `${base}/long-page.html`], { detached: true, stdio: 'ignore' }).unref();
    });
  }
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
