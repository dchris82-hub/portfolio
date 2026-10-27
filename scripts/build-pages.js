import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(root, 'deploy-config.json'), 'utf8'));
if (config.backend !== 'supabase' || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url) || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) throw Error('공개용 Supabase 연결 설정을 확인해 주세요.');
// Explicit allowlist: never copy source checkouts, Excel, SQL imports, previews or DBs.
const out = path.join(root, 'site');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const file of ['app.js', 'style.css', 'icon.svg', 'manifest.webmanifest', 'supabase-client.js']) copyFileSync(path.join(root, 'public', file), path.join(out, file));
const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.webmanifest'), 'utf8'));
manifest.start_url = './'; manifest.scope = './';
for (const i of manifest.icons) i.src = './' + i.src.replace(/^\//, '');
writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest));
let html = readFileSync(path.join(root, 'public/index.html'), 'utf8').replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./');
html = html.replace('<script type="module" src="./app.js"></script>', '<script src="./config.js"></script><script type="module" src="./app.js"></script>');
html = html.replace('이 문구만 계속 보이면 웹 미리보기에서 스크립트가 연결되지 않은 상태입니다.<br>별도로 제공된 preview.html 미리보기를 열어 주세요.', '연결이 지연되면 인터넷 연결을 확인한 뒤 새로고침해 주세요.');
writeFileSync(path.join(out, 'index.html'), html);
writeFileSync(path.join(out, 'config.js'), `window.PORTFOLIO_CONFIG = Object.freeze(${JSON.stringify(config)});\n`);
writeFileSync(path.join(out, '.nojekyll'), '');
console.log('GitHub Pages build ready in site/ (public assets only; no financial data).');
