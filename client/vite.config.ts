import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const developmentApiTarget = mode === 'production'
    ? 'http://localhost:3001'
    : process.env.VITE_DEV_API_TARGET ?? 'http://localhost:3001'
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: developmentApiTarget,
          changeOrigin: false,
        },
      },
    },
  }
})
