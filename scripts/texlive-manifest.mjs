import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/xelatex/repo/', import.meta.url));
const files = fs.readdirSync(path.join(root, 'xetex')).sort().flatMap(format =>
  fs.readdirSync(path.join(root, 'xetex', format)).sort().map(name => `${format}/${name}`));
const expected = JSON.stringify({ version: 1, files }, null, 2) + '\n';
const output = path.join(root, 'manifest.json');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== expected) {
    throw new Error('TeX resource manifest is stale. Run npm run tex:manifest.');
  }
} else {
  fs.writeFileSync(output, expected);
}
console.log(`TeX resource manifest: ${files.length} files`);
