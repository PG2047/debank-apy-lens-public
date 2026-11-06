import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const manifestPath = new URL('../dist/chrome-mv3/manifest.json', import.meta.url);
const bundlePath = new URL('../dist/chrome-mv3/content-scripts/bridge.js', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const bundle = readFileSync(bundlePath, 'utf8');

const moduleMarker = `[APY Lens] bridge module build ${packageJson.version}: evaluated`;
const mainMarker = '[APY Lens] scam filter build 0.3.5: bridge-enter';
const stateMarker = '[APY Lens] scam filter state:';
const moduleOffset = bundle.indexOf(moduleMarker);
const mainOffset = bundle.indexOf(mainMarker);
const stateOffset = bundle.indexOf(stateMarker);
const contextOffset = bundle.search(/new\s+[A-Za-z_$][\w$]*\(`bridge`,/);

if (manifest.version !== packageJson.version) {
  throw new Error(`manifest/package version mismatch: ${manifest.version} != ${packageJson.version}`);
}
if (moduleOffset < 0 || mainOffset < 0 || stateOffset < 0) {
  throw new Error('bridge diagnostic marker missing');
}
if (contextOffset < 0) throw new Error('WXT bridge ContentScriptContext construction missing');
if (!(moduleOffset < mainOffset && moduleOffset < contextOffset)) {
  throw new Error('module marker is not emitted before bridge main/context construction');
}

const sha256 = createHash('sha256').update(bundle).digest('hex');
console.log(JSON.stringify({
  version: manifest.version,
  bytes: Buffer.byteLength(bundle),
  sha256,
  offsets: {
    module: moduleOffset,
    main: mainOffset,
    state: stateOffset,
    wxtContext: contextOffset,
  },
}));
