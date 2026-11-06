import { defineConfig } from 'wxt';
import { APPROVED_HOST_PERMISSIONS } from './utils/hosts';

export default defineConfig({
  // 输出到可见目录（默认 .output 在 macOS 文件选择器里被隐藏，加载扩展时选不到）
  outDir: 'dist',
  manifest: {
    name: 'DeBank APY Lens',
    homepage_url: 'https://github.com/PG2047/debank-apy-lens-public',
    description:
      '在 DeBank 仓位上叠加实时收益率拆解：基础利息 / 激励奖励 / 循环贷净APY与杠杆',
    permissions: ['storage'],
    // 收益率数据源（全部 keyless）；DeBank 本身不在列表里——我们只旁听页面自己的响应
    host_permissions: [...APPROVED_HOST_PERMISSIONS],
    minimum_chrome_version: '111',
  },
});
