// Lists translated pages that are missing, or that were made from another version of the
// English page (their `sourceHash` differs from the English page's). After `pnpm build`, it also
// lists translated pages whose heading ids differ from the English page's: translations give
// their headings the English ids (`## 見出し {#results}`), so that links keep working.
//
//   node scripts/check-translations.mjs [--strict]   (--strict: exit with 1 when any is listed)
//   node scripts/check-translations.mjs --ids guide/client   (the English headings and their ids)

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = fileURLToPath(new URL('../src/content/docs/', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const locales = ['ja', 'zh-cn'];

const sourceHash = (file) => readFileSync(file, 'utf8').match(/^sourceHash:\s*(\S+)/m)?.[1];

function* englishPages(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === docs && locales.includes(entry.name)) continue;
      yield* englishPages(path);
    } else if (entry.name.endsWith('.md')) {
      yield relative(docs, path);
    }
  }
}

// The headings of a built page: [id, text].
function headings(page) {
  const file = join(dist, page, 'index.html');
  if (!existsSync(file)) return undefined;
  const html = readFileSync(file, 'utf8');
  return [...html.matchAll(/<h([2-6]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)]
    .filter((m) => !m[2].startsWith('starlight__'))
    .map((m) => [m[2], m[3].replace(/<[^>]+>/g, '').trim()]);
}

const idsAt = process.argv.indexOf('--ids');
if (idsAt !== -1) {
  const list = headings(process.argv[idsAt + 1]);
  if (list === undefined) throw new Error('build the site first (pnpm build)');
  for (const [id, text] of list) console.log(`{#${id}}  ${text}`);
  process.exit(0);
}

const problems = [];
for (const page of englishPages(docs)) {
  const hash = sourceHash(join(docs, page));
  if (hash === undefined) continue;
  for (const locale of locales) {
    const file = join(docs, locale, page);
    if (!existsSync(file)) problems.push(`missing  ${locale}/${page}`);
    else if (sourceHash(file) !== hash) problems.push(`stale    ${locale}/${page} (English is ${hash})`);
    const slug = page.slice(0, -'.md'.length);
    const english = headings(slug)?.map(([id]) => id);
    const translated = headings(`${locale}/${slug}`)?.map(([id]) => id);
    if (english && translated && existsSync(file) && english.join() !== translated.join()) {
      const missing = english.filter((id) => !translated.includes(id));
      problems.push(`headings ${locale}/${page}: ${missing.length ? `no ${missing.slice(0, 5).join(', ')}` : 'different order or extra ids'}`);
    }
  }
}

if (problems.length === 0) {
  console.log('every page is translated from the current English text');
} else {
  console.log(problems.join('\n'));
  if (process.argv.includes('--strict')) process.exit(1);
}
