import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'

// Dev: `npm run dev` here + `npm run dev` at the repo root — Vite serves the UI
// with HMR and proxies API + plugin assets to the Express app. Set BACKEND to
// point elsewhere (default matches config.port).
const backend = process.env.BACKEND || 'http://localhost:8787'

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  server: {
    proxy: {
      '/api': backend,
      '/plugins': backend,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
  },
})
