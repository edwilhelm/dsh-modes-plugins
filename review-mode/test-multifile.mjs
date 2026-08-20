// Multi-file / modified-hunk parser test.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('.', import.meta.url).pathname;
const clientSrc = readFileSync(new URL('client.js', import.meta.url), 'utf8');
function extract(name) {
  const re = new RegExp(`function ${name}\\(([\\s\\S]*?)\\n}`);
  const m = re.exec(clientSrc);
  if (!m) throw new Error(`could not extract ${name}`);
  return `function ${name}(${m[1]}\n}`;
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(extract('parseUnifiedDiff') + '\n;this.p = parseUnifiedDiff;', sandbox);

// Two files: a modified file (with +/- and context) and a deleted file.
const sample = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' keep1',
  '-old',
  '+new',
  ' keep4',
  '@@ -10,2 +10,2 @@',
  ' x',
  '-gone',
  '+added',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-bye',
  '-line2',
].join('\n');

const files = sandbox.p(sample);
console.log('blocks:', files.length);
files.forEach((b, i) => {
  console.log(`file ${i} headers:`, JSON.stringify(b.headers));
  b.hunks.forEach((h, hi) => {
    const brief = h.lines.map((l) => l.kind + l.text.replace(/^[+-]/, '')).join(' | ');
    console.log(`  hunk ${hi}: ${brief}`);
  });
});

if (files.length !== 2) throw new Error('expected 2 file blocks, got ' + files.length);
const f0 = files[0];
if (f0.headers[1] !== '+++ b/src/a.ts') throw new Error('a.ts ++ header wrong');
if (f0.hunks.length !== 2) throw new Error('expected 2 hunks in a.ts');
const f1 = files[1];
if (f1.hunks[0].lines.some((l) => l.kind !== '-')) throw new Error('deleted file should be all -');
console.log('\nMULTI-FILE PARSER OK.');