/**
 * Assert that the wire protocol has not drifted between the two halves of the
 * project.
 *
 * `mcp-server/src/protocol.js` and `extension/shared/protocol.js` are the same
 * file living in two runtimes. If one gains a method or renames an error code
 * and the other does not, nothing fails loudly — requests just start timing out
 * with no explanation. This check turns that into a build error.
 *
 * The leading block comment is allowed to differ, since each copy points at the
 * other; everything after it must match byte for byte.
 *
 * Usage: node scripts/check-protocol.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_COPY = path.join(here, '..', 'src', 'protocol.js');
const EXTENSION_COPY = path.join(here, '..', '..', 'extension', 'shared', 'protocol.js');

/** Drop the leading `/** ... *\/` doc block and normalise line endings. */
function body(source) {
  const end = source.indexOf('*/');
  const rest = source.startsWith('/**') && end !== -1 ? source.slice(end + 2) : source;
  return rest.replace(/\r\n/g, '\n').trim();
}

const [serverSource, extensionSource] = await Promise.all([
  readFile(SERVER_COPY, 'utf8'),
  readFile(EXTENSION_COPY, 'utf8').catch(() => null),
]);

if (extensionSource === null) {
  console.error(`FAIL: ${EXTENSION_COPY} does not exist.`);
  process.exit(1);
}

const a = body(serverSource);
const b = body(extensionSource);

if (a === b) {
  console.log('OK: protocol.js is identical in mcp-server/src and extension/shared.');
  process.exit(0);
}

// Report the first divergent line so the fix is obvious.
const aLines = a.split('\n');
const bLines = b.split('\n');
const max = Math.max(aLines.length, bLines.length);
let firstDiff = -1;
for (let i = 0; i < max; i++) {
  if (aLines[i] !== bLines[i]) {
    firstDiff = i;
    break;
  }
}

console.error('FAIL: the two copies of protocol.js have diverged.');
console.error(`  server:    ${SERVER_COPY}`);
console.error(`  extension: ${EXTENSION_COPY}`);
if (firstDiff !== -1) {
  console.error(`\nFirst difference at body line ${firstDiff + 1}:`);
  console.error(`  server:    ${JSON.stringify(aLines[firstDiff] ?? '(end of file)')}`);
  console.error(`  extension: ${JSON.stringify(bLines[firstDiff] ?? '(end of file)')}`);
}
console.error('\nCopy the canonical version over the other:');
console.error(`  cp "${SERVER_COPY}" "${EXTENSION_COPY}"   # then restore its header comment`);
process.exit(1);
