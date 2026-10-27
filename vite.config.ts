import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 开发时固定端口，方便 tauri.conf.json 的 devUrl 对上
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    // 语言包按需动态导入，主包不必压在 500KB 以内
    chunkSizeWarningLimit: 2000
  }
})
