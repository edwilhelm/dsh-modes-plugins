// ============================================================================
// Helper for the auto-diff review plugin.
//   node plugin.mjs host       -> the host half (paste into code.host)
//   node plugin.mjs client     -> the browser half (paste into code.client)
//   node plugin.mjs json       -> a ready-to-paste cordis_define payload (JSON)
// ============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const host = readFileSync(join(here, 'host.js'), 'utf8');
const client = readFileSync(join(here, 'client.js'), 'utf8');

// cordis_define expects each half as a plain JS function-body string (evaluated
// as the body of an async function). Our files end in `return {...};`, so paste
// them verbatim. Strip only the leading comment banner.
const stripTopComment = (s) => s.replace(/^\/\/ =+[\s\S]*?^\s*\r?\n{1,2}/m, '');
const hostBody = stripTopComment(host);
const clientBody = stripTopComment(client);

const arg = process.argv[2];
if (arg === 'host' || arg === 'code') {
  process.stdout.write(hostBody.replace(/\r?\n$/, ''));
} else if (arg === 'client') {
  process.stdout.write(clientBody.replace(/\r?\n$/, ''));
} else if (arg === 'json') {
  const payload = {
    plugin: { kind: 'new', idPrefix: 'adif' },
    name: 'auto-diff-review',
    purpose: 'Native Auto-Diff review panel listing session patches and a per-file diff viewer',
    code: { host: hostBody, client: clientBody },
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  console.log('# Host half — paste into cordis_define -> code.host :');
  console.log('```js'); console.log(hostBody); console.log('```');
  console.log('\n# Browser half — paste into cordis_define -> code.client :');
  console.log('```js'); console.log(clientBody); console.log('```');
  console.log('\n# Ready JSON payload for cordis_define:  node plugin.mjs json');
}