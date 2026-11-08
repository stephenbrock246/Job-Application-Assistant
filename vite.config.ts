import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx, type ManifestV3Export } from '@crxjs/vite-plugin'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const extensionDir = path.resolve(rootDir, 'extension')

// The manifest lives at extension/src/manifest.json (per the project spec), but every
// path inside it is resolved relative to the Vite root, which is `extension/`.
const manifest = JSON.parse(
  readFileSync(path.resolve(extensionDir, 'src/manifest.json'), 'utf-8'),
) as ManifestV3Export

export default defineConfig({
  root: extensionDir,
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': path.resolve(extensionDir, 'src'),
    },
  },
  // Vite's root is extension/, but postcss/tailwind config live at the repo root.
  css: {
    postcss: rootDir,
  },
  build: {
    outDir: path.resolve(rootDir, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome116',
  },
  server: {
    port: 5173,
    strictPort: true,
    // CRXJS needs a fixed HMR port so the extension pages can reconnect.
    hmr: { port: 5174 },
  },
})
