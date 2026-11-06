import { defineConfig } from 'wxt';
import { APPROVED_HOST_PERMISSIONS } from './utils/hosts';

export default defineConfig({
  // 输出到可见目录（默认 .output 在 macOS 文件选择器里被隐藏，加载扩展时选不到）
  outDir: 'dist',
  manifest: {
    name: '__MSG_extensionName__',
    default_locale: 'en',
    homepage_url: 'https://github.com/PG2047/debank-apy-lens-public',
    description: '__MSG_extensionDescription__',
    action: { default_title: '__MSG_actionTitle__' },
    permissions: ['storage'],
    // 收益率数据源（全部 keyless）；DeBank 本身不在列表里——我们只旁听页面自己的响应
    host_permissions: [...APPROVED_HOST_PERMISSIONS],
    minimum_chrome_version: '111',
  },
});
