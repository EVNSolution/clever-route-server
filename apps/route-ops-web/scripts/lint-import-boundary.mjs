import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const forbidden = [
  /@shopify\//u,
  /@shopify\/shopify-app-react-router/u,
  /shopify\.server/u,
  /AppBridge/u,
  /app-bridge/u,
  /gid:\/\/shopify\//iu,
  /\.\.\/shopify-clever/u,
  /05_CLEVER_Shopify/u,
  /shopify-clever\/apps\/shopify-app/u
];
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', '.vite'].includes(entry)) continue;
      walk(path);
      continue;
    }
    if (![...extensions].some((extension) => path.endsWith(extension))) continue;
    const text = readFileSync(path, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push(`${path.replace(root, '')}: ${pattern}`);
    }
  }
}

walk(join(root, 'src'));
walk(join(root, 'tests'));

if (violations.length > 0) {
  console.error('Route Ops web must not import or assume Shopify runtime modules/ids.');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}
