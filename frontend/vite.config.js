/**
 * Vite 构建 / 开发服务器配置
 * ---------------------------------------------------------------------------
 * 关键点（与后端 app.py 的 CORS 配置严格对齐）：
 *   1. 固定端口 5173：后端 CORSMiddleware 只放行了 http://localhost:5173，
 *      一旦 Vite 因为端口被占用自动顺延到 5174，浏览器就会因跨域被拦截。
 *      所以这里开启 strictPort，端口被占用时直接报错，而不是静默换端口。
 *
 *   2. /api 代理到 FastAPI：开发阶段所有接口请求都走同源路径 /api/xxx，
 *      由 Vite 转发到 http://127.0.0.1:8000，浏览器视角下不存在跨域，
 *      既绕开了 CORS 预检，也让前端代码里不用写死后端地址。
 *
 *   3. changeOrigin: true：转发时把 Host 头改写成目标地址，
 *      避免部分反向代理/后端中间件做 Host 校验时返回 403。
 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],

  server: {
    // 后端 CORS 白名单就是这一个源，因此端口必须锁死
    port: 5173,
    strictPort: true,
    host: 'localhost',
    open: false,

    proxy: {
      // 所有 /api 开头的请求转发给本地 FastAPI 服务
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        // 后端做的是纯 CPU/GPU 推理，不涉及 WebSocket，保持默认 http 即可
        ws: false,
      },
    },
  },

  build: {
    // 生成 sourcemap 便于线上排查，体积影响可忽略
    sourcemap: false,
    outDir: 'dist',
    // 单块体积告警阈值放宽到 1MB（本项目依赖很轻，仅作防噪音）
    chunkSizeWarningLimit: 1024,
  },
})
