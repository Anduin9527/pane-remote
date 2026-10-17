import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import path from 'node:path'

// 构建产物放到 ../public，由 server/server.mjs 提供静态文件；相对路径，挂在哪个子路径都能用。
// 手机缓存里的旧首页如果引用了已经删掉的旧 assets，服务端会给同类型的最新文件，不会白屏
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), svelte()],
  // 每次构建都带上构建时间：脚本内容随之变化，文件名（内容哈希）每次都是新的，手机里任何坏掉的旧缓存都用不上
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  resolve: { alias: { $lib: path.resolve('./src/lib') } },
  build: { outDir: '../public', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
