#!/usr/bin/env node
// Offline gate for the GitHub Pages site published from `docs/` (Pages source:
// branch `main`, path `/docs`). Network-free by design so `npm run check` stays
// deterministic: external URLs are only shape-checked, and links that point back
// into the repository are resolved against the working tree instead of fetched.
//
// Invariants enforced:
//   1. Nothing in `docs/` links outside `docs/` — the Pages source dir has no
//      parent, so `../README.md` 404s on the published site. Repo files must be
//      linked as `https://github.com/sg0zzy/phonehaul/blob/main/<path>`.
//   2. Every relative link resolves to a file in `docs/` (`.md` targets are
//      published by Jekyll as `.html`, so `x.html` may resolve to `x.md`).
//   3. Every `#fragment` matches a heading in the target Markdown file.
//   4. `docs/index.html` links every published page, so nothing is orphaned.
//   5. External links are `https:` and the repo blob paths exist on disk.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repoRoot, 'docs');
const repoBlobPrefix = 'https://github.com/sg0zzy/phonehaul/blob/main/';

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

/** GitHub Pages publishes Markdown and HTML; everything else is invisible. */
const isPublished = (name) => /\.(md|html)$/.test(name);

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w -]+/g, '')
    .replace(/ /g, '-');
}

/** Heading ids Jekyll/GitHub generate for a Markdown file, duplicates suffixed. */
function headingSlugs(markdown) {
  const slugs = new Set();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    let slug = slugify(match[2]);
    for (let n = 1; slugs.has(slug); n += 1) slug = `${slugify(match[2])}-${n}`;
    slugs.add(slug);
  }
  return slugs;
}

/**
 * Link targets in a document, with fenced code and inline code spans removed so
 * example paths in code blocks are not mistaken for navigation.
 */
function extractLinks(source, name) {
  const withoutFences = source.replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, '');
  const text = withoutFences.replace(/`[^`\n]*`/g, '');
  const links = [];
  const patterns = [
    /\]\(\s*<?([^)\s>]+)>?\s*\)/g, // markdown: [text](target)
    /\[[^\]]*\]:\s*<?([^\s>]+)>?/g, // reference definitions
    /(?:href|src)\s*=\s*["']([^"']+)["']/gi, // html attributes
    /<((?:https?:\/\/|mailto:)[^>\s]+)>/g, // autolinks
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) links.push(match[1]);
  }
  return links.map((target, index) => ({ target, where: `${name}#${index + 1}` }));
}

const files = (await readdir(docsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && isPublished(entry.name))
  .map((entry) => entry.name)
  .sort();

if (!files.includes('index.html')) {
  fail('docs/', 'no index.html — the Pages root 404s and the docs have no entry point');
}

const contents = new Map();
for (const name of files) contents.set(name, await readFile(path.join(docsDir, name), 'utf8'));

// A published target resolves to a file in docs/, honouring md -> html rendering.
function resolveTarget(target) {
  if (target.endsWith('.md')) return files.includes(target) ? target : null;
  if (target.endsWith('.html')) {
    if (files.includes(target)) return target;
    const asMarkdown = `${target.slice(0, -'.html'.length)}.md`;
    return files.includes(asMarkdown) ? asMarkdown : null;
  }
  // Extensionless targets (e.g. `protocol`) are not published by Jekyll.
  return files.includes(target) ? target : null;
}

for (const name of files) {
  for (const { target, where } of extractLinks(contents.get(name), name)) {
    if (/^https?:\/\//i.test(target)) {
      if (!target.startsWith('https://')) fail(where, `insecure link: ${target}`);
      if (target.startsWith(repoBlobPrefix)) {
        const [repoPath, fragment] = decodeURIComponent(target.slice(repoBlobPrefix.length)).split(
          '#',
        );
        if (!repoPath) fail(where, 'repository blob link has no path');
        else {
          try {
            const repoFile = await readFile(path.join(repoRoot, repoPath), 'utf8');
            if (fragment && repoPath.endsWith('.md')) {
              if (!headingSlugs(repoFile).has(fragment)) {
                fail(where, `anchor #${fragment} does not match a heading in ${repoPath}`);
              }
            }
          } catch {
            fail(where, `repository blob link has no file in the tree: ${repoPath}`);
          }
        }
      }
      continue;
    }

    if (target.startsWith('#')) {
      const slug = target.slice(1);
      if (name.endsWith('.md') && !headingSlugs(contents.get(name)).has(slug)) {
        fail(where, `anchor #${slug} does not match a heading in ${name}`);
      }
      continue;
    }

    if (/^[{<$]/.test(target)) continue; // templated or placeholder hrefs

    const [rawPath, fragment] = target.split('#');
    if (!rawPath) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), rawPath));
    if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
      fail(
        where,
        `link escapes the Pages source dir (docs/): ${target} — link the repo file as ` +
          `${repoBlobPrefix}<path> instead`,
      );
      continue;
    }
    const inside = resolved.replace(/^docs\//, '');
    const target2 = resolveTarget(inside);
    if (!target2) {
      fail(where, `relative link has no published target in docs/: ${target}`);
      continue;
    }
    if (fragment && target2.endsWith('.md')) {
      if (!headingSlugs(contents.get(target2)).has(fragment)) {
        fail(where, `anchor #${fragment} does not match a heading in ${target2}`);
      }
    }
  }
}

// The index must reach every published page, otherwise it is not an index.
const indexSource = contents.get('index.html');
if (indexSource) {
  const indexLinks = new Set(extractLinks(indexSource, 'index.html').map(({ target }) => target));
  for (const name of files) {
    if (name === 'index.html') continue;
    const rendered = name.endsWith('.md') ? `${name.slice(0, -3)}.html` : name;
    if (!indexLinks.has(name) && !indexLinks.has(rendered)) {
      fail('docs/index.html', `published page is not linked from the index: ${name}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`docs link check failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`docs link check passed (${files.length} published pages)`);
