// Standalone smoke test for the unified-diff parser used by the browser half.
// Loads client.js as text, extracts pure function sources by name, and runs
// them in a vm against a real auto-diff.patch sample.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('.', import.meta.url).pathname;
const clientSrc = readFileSync(new URL('client.js', import.meta.url), 'utf8');

// Pull out the top-level function declarations we need (no React/host needed).
function extract(name) {
  const re = new RegExp(`function ${name}\\(([\\s\\S]*?)\\n}`); // naive: ends at first \n}
  const m = re.exec(clientSrc);
  if (!m) throw new Error(`could not extract ${name}`);
  return `function ${name}(${m[1]}\n}`;
}
const parserSrc = extract('parseUnifiedDiff');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(parserSrc + '\n;this.parseUnifiedDiff = parseUnifiedDiff;', sandbox);

const patch = readFileSync(
  'C:/Users/Ed/.dsh/sessions/--C-Users-Ed-Downloads-deepseektest--/session-109e92d6-4489-4fe4-9ff4-e5c2a8ff2f27/auto-diff.patch',
  'utf8',
);

const files = sandbox.parseUnifiedDiff(patch);
console.log('file blocks:', files.length);
for (const b of files) {
  console.log('headers:', JSON.stringify(b.headers));
  console.log('hunks:', b.hunks.length, 'lines:', b.hunks.reduce((n, h) => n + h.lines.length, 0));
  for (const h of b.hunks) {
    for (const ln of h.lines) console.log(`  [${ln.kind}] ${JSON.stringify(ln.text)}`);
  }
}

// basic assertions
if (files.length !== 1) throw new Error('expected 1 file block');
if (files[0].headers.length !== 3) throw new Error('expected 3 header lines (---/+++/@@), got ' + JSON.stringify(files[0].headers));
const initialPlus = files[0].hunks[0].lines.filter((l) => l.kind === '+');
if (initialPlus.length !== 1 || initialPlus[0].text.indexOf('heartbeat') < 0) throw new Error('expected one added line');
console.log('\nPARSER OK: per-file diff parsed correctly.');