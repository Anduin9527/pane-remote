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
  // 按需加载的分块不能叫 index-*：服务端找不到旧首页引用的 assets/index-* 时会拿最新的同类文件顶上（见 server/server.mjs），
  // 分块也叫 index-* 的话会被顶错
  build: {
    outDir: '../public', emptyOutDir: true, chunkSizeWarningLimit: 1000,
    rolldownOptions: { output: { chunkFileNames: 'assets/c-[name]-[hash].js', assetFileNames: (a) => (a.names?.[0]?.endsWith('.css') && a.names[0] !== 'index.css' ? 'assets/c-[name]-[hash][extname]' : 'assets/[name]-[hash][extname]') } },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
