import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Checks the Mintlify site in docs-site without the Mintlify CLI and without a network. It reads docs.json and the
 * pages, and reports:
 *   - a page named in the navigation that has no file,
 *   - a page file that is not in the navigation,
 *   - a page with no title or description in its front matter,
 *   - an internal link or image that does not resolve, including a #heading that is not on the target page,
 *   - a relative link (use /page instead) and a plain http link.
 * External https links are not fetched. Run it from anywhere: node scripts/docs/check-docs.mjs [docs folder]
 */
const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs-site');
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

/** Every page name in docs.json: the strings inside a "pages" list, however deeply groups, tabs and dropdowns nest. */
function navigationPages(node, found = [], inPages = false) {
  if (typeof node === 'string') {
    if (inPages) found.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) navigationPages(item, found, inPages);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) navigationPages(value, found, key === 'pages');
  }
  return found;
}

/** Every page file under the folder, as a page name without its extension. */
function pageFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path, base);
    return ['.mdx', '.md'].includes(extname(entry.name)) ? [relative(base, path).replace(/\.mdx?$/, '')] : [];
  });
}

/** The anchor Mintlify and GitHub make from a heading: lower case, punctuation dropped, spaces to dashes. */
const slug = heading =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');

const withoutCode = text => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

if (!existsSync(join(root, 'docs.json'))) {
  console.error(`No docs.json in ${root}`);
  process.exit(2);
}
const config = JSON.parse(readFileSync(join(root, 'docs.json'), 'utf8'));
const listed = navigationPages(config.navigation);
const files = pageFiles(root);

for (const page of new Set(listed)) if (!files.includes(page)) fail('docs.json', `the page "${page}" has no .mdx file`);
const duplicates = listed.filter((page, index) => listed.indexOf(page) !== index);
for (const page of new Set(duplicates)) fail('docs.json', `the page "${page}" is listed more than once`);
for (const page of files) if (!listed.includes(page)) fail(`${page}.mdx`, 'is not in the navigation in docs.json');

const anchors = new Map();
const bodies = new Map();
for (const page of files) {
  const path = ['.mdx', '.md'].map(extension => join(root, page + extension)).find(existsSync);
  const text = readFileSync(path, 'utf8');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  for (const field of ['title', 'description']) {
    if (!front || !new RegExp(`^${field}:\\s*\\S`, 'm').test(front[1])) fail(`${page}.mdx`, `front matter has no ${field}`);
  }
  const body = withoutCode(front ? text.slice(front[0].length) : text);
  bodies.set(page, body);
  anchors.set(page, new Set([...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => slug(match[1]))));
}

for (const [page, body] of bodies) {
  const targets = [
    ...[...body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1]),
    ...[...body.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map(match => match[1]),
  ];
  for (const target of targets) {
    const where = `${page}.mdx`;
    if (/^(mailto:|tel:|data:)/.test(target)) continue;
    if (/^http:\/\//.test(target)) fail(where, `${target} is plain http`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // an external address, not fetched here
    const [pathPart, hash = ''] = target.split('#');
    const location = pathPart.split('?')[0];
    if (location && !location.startsWith('/')) {
      fail(where, `${target} is a relative link, so use a path from the site root such as /page`);
      continue;
    }
    const name = location.replace(/^\//, '').replace(/\/$/, '');
    const isFile = extname(name) !== '' && !/\.mdx?$/.test(name);
    if (location && isFile) {
      if (!existsSync(join(root, name))) fail(where, `${target} points to a file that does not exist`);
      continue;
    }
    const targetPage = location ? name.replace(/\.mdx?$/, '') : page;
    if (!files.includes(targetPage)) {
      fail(where, `${target} points to a page that does not exist`);
      continue;
    }
    if (hash && !anchors.get(targetPage)?.has(hash)) fail(where, `${target} points to a heading that is not on ${targetPage}`);
  }
}

if (errors.length > 0) {
  console.error(`docs check: ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(`docs check: ${files.length} pages, ${new Set(listed).size} in the navigation, all internal links resolve.`);
