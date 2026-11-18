// Copies the English documentation of a tsurara checkout into this site.
//
//   node scripts/sync-docs.mjs [path to tsurara]   (default: ../tsurara, or TSURARA_DIR)
//
// - README.md, docs/guide/*, docs/languages/* and docs/design.md become pages in
//   src/content/docs/ (the English locale). The first H1 becomes the `title`.
// - Relative links between those files become links between pages; links to other files of
//   the repository become GitHub links pinned to the synced commit.
// - Every page records `sourceHash`, a hash of its English text (without the pinned commit).
//   Translations copy the hash of the text they were made from; `pnpm translations` lists the
//   stale ones. GitHub links in translations are moved to the synced commit.
// - llms.txt and llms-full.txt are copied into public/.
// - The samples on the home page are generated with the checkout's tsurara binary.
// - tsurara.json records the commit.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? process.env.TSURARA_DIR ?? join(root, '../tsurara'));
const repoUrl = 'https://github.com/tsurara-openapi/tsurara';
const docsDir = join(root, 'src/content/docs');

const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
if (git('status', '--porcelain', '--', 'README.md', 'docs', 'llms.txt', 'llms-full.txt') !== '') {
  console.warn('warning: the documentation in the tsurara checkout has uncommitted changes');
}

// Source path (relative to the tsurara repository) → page slug.
const pages = new Map([['README.md', 'getting-started']]);
for (const dir of ['docs/guide', 'docs/languages']) {
  for (const file of readdirSync(join(source, dir)).sort()) {
    if (file.endsWith('.md')) pages.set(`${dir}/${file}`, `${dir.slice('docs/'.length)}/${file.slice(0, -3)}`);
  }
}
pages.set('docs/design.md', 'design');

const pageUrl = (slug) => `/${slug}/`;

function rewriteLink(target, from) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return target;
  const hashAt = target.indexOf('#');
  const path = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  const resolved = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '');
  const slug = pages.get(resolved);
  if (slug !== undefined) {
    const fromUrl = pageUrl(pages.get(from));
    let rel = posix.relative(fromUrl, pageUrl(slug));
    rel = rel === '' ? './' : `${rel}/`;
    return rel + hash;
  }
  const kind = existsSync(join(source, resolved)) && !resolved.includes('.') ? 'tree' : 'blob';
  return `${repoUrl}/${kind}/${commit}/${resolved}${hash}`;
}

// Rewrites the targets of inline links and link definitions, outside code.
function rewriteLinks(text, from) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const def = line.match(/^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/);
      if (def) return def[1] + rewriteLink(def[2], from) + def[3];
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2 === 1 ? part : part.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, t, title) => `](${rewriteLink(t, from)}${title})`),
        )
        .join('');
    })
    .join('\n');
}

// The hash leaves out the commit in GitHub links, so that a sync to another commit marks only
// pages whose text changed as stale.
const pinned = new RegExp(`(${repoUrl.replace(/[.]/g, '\\.')}/(?:blob|tree)/)[0-9a-f]{40}/`, 'g');
const hash = (text) =>
  createHash('sha256').update(text.replace(pinned, '$1-/')).digest('hex').slice(0, 12);
const yamlString = (s) => JSON.stringify(s);

function convert(from) {
  let text = readFileSync(join(source, from), 'utf8');
  const h1 = text.match(/^# (.+)\n+/m);
  if (!h1) throw new Error(`${from}: no H1`);
  let title = h1[1].trim();
  text = text.slice(0, h1.index) + text.slice(h1.index + h1[0].length);
  if (from === 'README.md') {
    title = 'Getting started';
    // The sidebar replaces the list of documents; the contributing and license sections
    // stay on the repository.
    text = text.replace(/\n## Documentation\n[\s\S]*$/, '\n');
  }
  text = rewriteLinks(text.trim(), from);
  const frontmatter = [
    '---',
    `title: ${yamlString(title)}`,
    `sourcePath: ${from}`,
    `sourceHash: ${hash(text)}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${text}\n`;
}

// English pages are written fresh; translated pages under ja/ and zh-cn/ are left as they are.
for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
  if (entry.name === 'ja' || entry.name === 'zh-cn' || entry.name === 'index.mdx') continue;
  rmSync(join(docsDir, entry.name), { recursive: true });
}
for (const [from, slug] of pages) {
  const out = join(docsDir, `${slug}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, convert(from));
}

// Translations keep the English links; point their GitHub links at the synced commit too.
for (const locale of ['ja', 'zh-cn']) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.mdx?$/.test(entry.name)) {
        const text = readFileSync(path, 'utf8');
        const pinnedText = text.replace(pinned, `$1${commit}/`);
        if (pinnedText !== text) writeFileSync(path, pinnedText);
      }
    }
  };
  if (existsSync(join(docsDir, locale))) walk(join(docsDir, locale));
}

// llms.txt links to Markdown files of the repository; point them at the pinned commit.
const llms = readFileSync(join(source, 'llms.txt'), 'utf8').replace(
  /\]\(([^)\s:]+\.md)\)/g,
  (_, path) => `](${repoUrl}/blob/${commit}/${path})`,
);
writeFileSync(join(root, 'public/llms.txt'), llms);
writeFileSync(join(root, 'public/llms-full.txt'), readFileSync(join(source, 'llms-full.txt')));

// Samples for the home page: one definition generated for every language.
// The newer of the release and debug binaries.
const binary = ['release', 'debug']
  .map((profile) => join(source, 'target', profile, 'tsurara'))
  .filter((path) => existsSync(path))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (binary === undefined) {
  console.warn('warning: no tsurara binary in target/; the samples were not regenerated');
} else {
  if (statSync(binary).mtimeMs / 1000 < Number(git('log', '-1', '--format=%ct'))) {
    console.warn(`warning: ${binary} is older than the synced commit; build it first (cargo build -p tsurara-cli)`);
  }
  const samples = join(root, 'samples');
  rmSync(join(samples, 'out'), { recursive: true, force: true });
  execFileSync(binary, ['generate'], { cwd: samples, stdio: 'inherit' });
}

// Without a binary the samples were not regenerated, so the recorded version stays.
const lockPath = join(root, 'tsurara.json');
const previous = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};
const version =
  binary === undefined ? previous.version : execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
writeFileSync(lockPath, `${JSON.stringify({ repository: repoUrl, commit, version }, null, 2)}\n`);
console.log(`synced ${pages.size} pages from ${relative(root, source) || source} at ${commit.slice(0, 12)}`);
