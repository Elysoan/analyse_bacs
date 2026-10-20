// Assemble une page autonome (un seul fichier HTML, à ouvrir par double-clic, sans dossier vendor/ ni js/).
// Usage : node tools/build-standalone.js [page.html] [sortie.html]   (par défaut tournee.html -> dist/tournee.html)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const page = process.argv[2] || 'tournee.html';
const out = process.argv[3] || path.join('dist', page);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let html = read(page);
const mime = { '.png': 'image/png', '.svg': 'image/svg+xml' };

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) => {
  let css = read(href);
  const dir = path.dirname(href);
  css = css.replace(/url\((['"]?)([^)'"]+)\1\)/g, (mm, q, u) => {
    if (/^(data:|https?:|#)/.test(u)) return mm;
    const file = path.join(root, dir, u);
    return fs.existsSync(file) ? `url(data:${mime[path.extname(u)] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')})` : mm;
  });
  return `<style>\n${css}\n</style>`;
});
// Logo facultatif : intégré s'il existe (img/logo.svg ou img/logo.png), retiré sinon.
html = html.replace(/<img class="brand-logo"[^>]*>/g, () => {
  for (const f of ['img/logo.svg', 'img/logo.png']) {
    const file = path.join(root, f);
    if (fs.existsSync(file)) return `<img class="brand-logo ok" alt="Paprec" src="data:${mime[path.extname(f)]};base64,${fs.readFileSync(file).toString('base64')}">`;
  }
  return '';
});
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => `<script>\n${read(src).replace(/<\/script/gi, '<\\/script')}\n</script>`);

fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
fs.writeFileSync(path.join(root, out), html);
console.log(out, (Buffer.byteLength(html) / 1e6).toFixed(2) + ' Mo');
