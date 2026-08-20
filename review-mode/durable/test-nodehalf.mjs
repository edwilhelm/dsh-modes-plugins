// Verify the decorator-lowered node half registers the Remote methods.
// typert-protocol is resolved from the SAME module graph the node half imports
// (durable/node_modules), so the private markers WeakMap instance is shared.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);

// Locate the packages exactly as the node half resolves them (durable pkg).
const typertEntry = require2.resolve('@deepseek-ai/dsh-typert-protocol');
const nodeHalfUrl = pathToFileURL(path.join(moduleDir, 'lib/index.js')).href;

const mod = await import(nodeHalfUrl);
const typert = await import(pathToFileURL(typertEntry).href);

console.log('node-half exports:', Object.keys(mod));
console.log('name:', mod.name, '| inject:', mod.inject);
console.log('typertEntry:', typertEntry.replace(moduleDir, '<durable>'));

// Minimal fake Cordis context: reflect.provide must exist (Service base calls it).
const fakeCtx = {
  provide() {},
  get: (k) => ({ fs: undefined, shellEnv: undefined, shell: undefined })[k],
  reflect: {
    props: {},
    provide(name, val) { this.props[name] = val; },
    add() {}, getAccessor() {}, own() {},
  },
  _ctx: undefined,
};

const service = new mod.AutoDiffReviewRemote(fakeCtx);
console.log('service.typertRemote (namespace/key):', service.typertRemote.namespace, '/', service.typertRemote.serviceKey);
console.log('has listPatches:', typeof service.listPatches === 'function');
console.log('has readPatch:', typeof service.readPatch === 'function');

const methods = typert.remoteMethods ? typert.remoteMethods(service) : null;
console.log('remoteMethods(service):', JSON.stringify(methods));

if (!methods || methods.length !== 2 ||
    !methods.some((m) => m.method === 'listPatches' && m.invocation.kind === 'direct') ||
    !methods.some((m) => m.method === 'readPatch' && m.invocation.kind === 'direct')) {
  console.error('NODE HALF FAIL: expected remoteMethods to expose listPatches + readPatch');
  process.exitCode = 1;
} else {
  console.log('NODE HALF OK: typert discovers 2 direct Remote methods (listPatches, readPatch).');
}