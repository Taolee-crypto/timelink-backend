import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      external: [],  // 필요시 Cloudflare 호환 모듈 제외
    }
  },
  server: {
    port: 3000
  }
})
