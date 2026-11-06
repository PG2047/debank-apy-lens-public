// 设置页（popup）：自定义各链 RPC 端点。留空 = 用内置 publicnode 默认。
// 「测试」按钮对目标端点发 eth_blockNumber 验证连通性。

import { CHAINS } from '@/utils/chains';
import { DEFAULT_RPC } from '@/utils/rpc';
import { getRpcOverrides, setRpcOverride, validRpcValue } from '@/utils/settings';

const CSS = `
body { margin: 0; width: 460px; background: #101418; color: #e8eaed;
  font: 13px/1.6 -apple-system, "SF Pro Text", "PingFang SC", sans-serif; }
.wrap { padding: 14px 16px; }
h1 { font-size: 14px; margin: 0 0 2px; }
.sub { color: #7d8590; font-size: 12px; margin-bottom: 12px; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.chain { width: 82px; flex: none; color: #c9d1d9; }
input { flex: 1; min-width: 0; padding: 5px 8px; border-radius: 6px; border: 1px solid #2a3138;
  background: #0a0d10; color: #e8eaed; font: 12px/1.4 ui-monospace, Menlo, monospace; }
input::placeholder { color: #4d5761; }
input.bad { border-color: #cf222e; }
button { padding: 4px 10px; border-radius: 6px; border: 1px solid #2a3138; background: #1c2228;
  color: #c9d1d9; cursor: pointer; flex: none; font-size: 12px; }
button:hover { background: #262d35; }
.st { width: 34px; flex: none; text-align: center; font-size: 12px; }
.ok { color: #3fb950; } .err { color: #f85149; }
.foot { color: #7d8590; font-size: 11px; margin-top: 10px; line-height: 1.5; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function testRpc(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const j = (await res.json()) as { result?: unknown };
    return typeof j?.result === 'string';
  } catch {
    return false;
  }
}

async function main() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const app = document.getElementById('app')!;
  const wrap = el('div', 'wrap');
  wrap.appendChild(el('h1', undefined, '自定义 RPC'));
  wrap.appendChild(
    el('div', 'sub', '留空用内置公共节点。支持逗号分隔多个 URL（逐请求轮转分摊配额）。修改即保存，跨设备同步。'),
  );

  const overrides = await getRpcOverrides();
  // 只列出有链上读取需求（Uniswap 区间）的链
  const chainIds = Object.keys(DEFAULT_RPC).map(Number);
  const byId = new Map(Object.entries(CHAINS).map(([, c]) => [c.chainId, c] as const));

  for (const chainId of chainIds) {
    const info = byId.get(chainId);
    const row = el('div', 'row');
    row.appendChild(el('span', 'chain', info?.label ?? String(chainId)));
    const input = document.createElement('input');
    input.placeholder = DEFAULT_RPC[chainId];
    input.value = overrides[String(chainId)] ?? '';
    input.spellcheck = false;
    const st = el('span', 'st', '');
    const save = async () => {
      const v = input.value.trim();
      if (v && !validRpcValue(v)) {
        input.classList.add('bad');
        st.textContent = '✗';
        st.className = 'st err';
        return;
      }
      input.classList.remove('bad');
      await setRpcOverride(chainId, v);
      st.textContent = '✓';
      st.className = 'st ok';
      setTimeout(() => (st.textContent = ''), 1200);
    };
    input.addEventListener('change', save);
    const btn = el('button', undefined, '测试');
    btn.addEventListener('click', async () => {
      st.textContent = '…';
      st.className = 'st';
      const target = (input.value.split(',')[0] || '').trim() || DEFAULT_RPC[chainId];
      const ok = await testRpc(target);
      st.textContent = ok ? '✓' : '✗';
      st.className = `st ${ok ? 'ok' : 'err'}`;
    });
    row.appendChild(input);
    row.appendChild(btn);
    row.appendChild(st);
    wrap.appendChild(row);
  }

  wrap.appendChild(
    el('div', 'foot', '自定义 RPC 仅用于链上直读（Uniswap LP 区间等）。需允许浏览器跨域访问（主流 RPC 服务商均支持）。'),
  );
  app.appendChild(wrap);
}

void main();
