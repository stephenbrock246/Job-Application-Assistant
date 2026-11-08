/**
 * Dev-only: renders the real side panel in a normal browser page, with a stubbed
 * `chrome` API and sample data, so the UI can be looked at and screenshotted
 * without loading the extension.
 *
 *   npx vite --config scripts/ui-preview/vite.config.ts
 *   open http://localhost:5180/?scenario=session   (idle | session | settings)
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(repo, 'extension/src') } },
  css: { postcss: repo },
  server: { port: 5180, strictPort: true, fs: { allow: [repo] } },
})
