import process from 'node:process';

import { defineConfig } from '@vben/vite-config';

export default defineConfig(async () => {
  return {
    application: {},
    vite: {
      // 多实例并行开发（worktree 隔离栈）用 VITE_CACHE_DIR 错开依赖预构建缓存，
      // 避免两个 vite 共写 node_modules/.vite；缺省=单实例默认行为
      cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
      server: {
        // 上游共享配置 host:true 会绑全网卡（LAN 可访问 dev 页面）；单人本机场景收紧为只绑本机
        host: 'localhost',
        proxy: {
          // 管理后端（NestJS 3210）：路径带 /api 前缀原样转发，不重写；
          // worktree 隔离栈用 VITE_ADMIN_API_TARGET 指临时后端（如 3211）
          '/api': {
            changeOrigin: true,
            target:
              process.env.VITE_ADMIN_API_TARGET || 'http://127.0.0.1:3210',
            ws: true,
          },
        },
      },
    },
  };
});
