import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inventory, compare, officialPattern, repository } from './official.js';
const [version, file] = process.argv.slice(2);
if (!officialPattern.test(version)) throw new Error('invalid release version');
const baseline = inventory()
  .releases.filter((r) => !r.draft && !r.prerelease && compare(r.tag_name.slice(1), version) < 0)
  .map((r) => r.tag_name)
  .sort((a, b) => compare(a.slice(1), b.slice(1)))
  .at(-1);
const tag = `v${version}`,
  range = baseline ? `${baseline}..${tag}` : tag;
if (baseline) execFileSync('git', ['merge-base', '--is-ancestor', baseline, tag]); // divergent history requires explicit review
const log = execFileSync('git', ['log', '--no-merges', '--pretty=format:- %s (%h)', range], {
  encoding: 'utf8',
});
const text = `# PhoneHaul ${version}\n\nBaseline: ${baseline ?? 'initial reachable history (no completed stable release)'}\n\n${log}\n\n${baseline ? `[Full comparison](https://github.com/${repository}/compare/${baseline}...${tag})` : ''}\n\nOptional omissions and target outcomes: see release-manifest.json.\n\nGenerated notes require human review in the release-publication environment before publication.\n`;
if (file) fs.writeFileSync(file, text);
else process.stdout.write(text);
