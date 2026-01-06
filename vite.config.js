import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'stream', 'util', 'events', 'crypto'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    proxy: {
      '/opensea': {
        target: 'https://api.opensea.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opensea/, ''),
      },
    },
  },
})
