// Build-time discovery only. No wallet data, credentials, or runtime remote configuration.
// Review the generated diff, then run tests/build before distributing the extension.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const sources = {
  debank: 'https://api.debank.com/chain/list',
  rabby: 'https://raw.githubusercontent.com/RabbyHub/Rabby/master/src/constant/default-support-chains.json',
  llama: 'https://api.llama.fi/v2/chains',
  uniswap: 'https://developers.uniswap.org/deployments.json',
};
async function json(url) {
  const { stdout } = await run('curl', ['-fsSL', '--max-time', '30', '-A', 'Mozilla/5.0', url], { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
const [debank, rabby, llama, uniswap] = await Promise.all(Object.values(sources).map(json));
const rows = debank?.data?.chains;
if (!Array.isArray(rows) || rows.length < 50 || rows.length > 500) throw new Error('Invalid DeBank chain inventory');
if (!Array.isArray(rabby) || !Array.isArray(llama) || !Array.isArray(uniswap?.records)) throw new Error('Invalid deployment sources');
const oldPath = new URL('../utils/deployments.json', import.meta.url);
const previous = await readFile(oldPath, 'utf8').then(JSON.parse).catch(() => ({ chains: [] }));
const chainIds = new Set();
const ids = new Set();
const llamaOverrides = { 56: 'BSC', 10: 'OP Mainnet', 324: 'ZKsync Era', 999: 'Hyperliquid L1', 196: 'X Layer' };
const chains = rows.map((row) => {
  const { id, network_id: chainId, name: label, token_symbol: nativeSymbol } = row;
  if (!/^[a-z0-9]+$/.test(id) || !Number.isSafeInteger(chainId) || chainId <= 0 ||
      typeof label !== 'string' || label.length > 64 || typeof nativeSymbol !== 'string' || nativeSymbol.length > 32 ||
      chainIds.has(chainId) || ids.has(id)) throw new Error('Invalid or duplicate chain identity');
  chainIds.add(chainId); ids.add(id);
  const nativeDecimals = rabby.find((c) => c.id === id && c.community_id === chainId)?.native_token?.decimals ?? 18;
  if (!Number.isInteger(nativeDecimals) || nativeDecimals < 0 || nativeDecimals > 36) throw new Error('Invalid native decimals');
  const names = llama.filter((c) => String(c.chainId) === String(chainId)).map((c) => c.name);
  const llamaName = llamaOverrides[chainId] ?? (names.length === 1 ? names[0] : previous.chains.find((c) => c.chainId === chainId)?.llama ?? label);
  return { id, chainId, label, llama: llamaName, nativeSymbol, nativeDecimals };
}).sort((a, b) => a.chainId - b.chainId);

const contracts = { v3: ['UniswapV3Factory', 'NonfungiblePositionManager'], v4: ['PositionManager', 'StateView'] };
const deployments = { v3: {}, v4: {} };
for (const row of uniswap.records) {
  if (row.env !== 'mainnet' || row.status !== 'active' || !contracts[row.protocol]?.includes(row.contract)) continue;
  if (!Number.isSafeInteger(row.chainId) || row.chainId <= 0 || !/^0x[0-9a-f]{40}$/i.test(row.address)) throw new Error('Invalid Uniswap deployment');
  const chain = deployments[row.protocol][row.chainId] ??= {};
  const address = row.address.toLowerCase();
  if (chain[row.contract] && chain[row.contract] !== address) throw new Error('Conflicting Uniswap deployment');
  chain[row.contract] = address;
}
for (const [version, byChain] of Object.entries(deployments)) {
  if (Object.keys(byChain).length < 6) throw new Error('Incomplete Uniswap inventory');
  for (const row of Object.values(byChain)) {
    if (!contracts[version].every((name) => row[name])) throw new Error(`Incomplete Uniswap ${version} deployment`);
  }
}
const output = {
  observedAt: new Date().toISOString().slice(0, 10),
  sources: { ...sources, uniswapCommit: uniswap.source?.commit },
  chains,
  uniswap: deployments,
};
if (process.argv.includes('--check')) {
  if (JSON.stringify({ ...previous, observedAt: '' }) !== JSON.stringify({ ...output, observedAt: '' })) {
    throw new Error('Deployment inventory changed; run npm run sync:deployments and review the diff');
  }
} else {
  await writeFile(oldPath, `${JSON.stringify(output, null, 2)}\n`);
}
console.log(JSON.stringify({ chains: chains.length, uniswapV3: Object.keys(deployments.v3).length, uniswapV4: Object.keys(deployments.v4).length }));
