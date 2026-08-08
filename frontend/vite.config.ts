import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The backend (risk engine + oracle) is started by dev.mjs, not from here.
// A Vite plugin restarts with the config, and each restart re-ran the oracle
// against a feed the contract had already consumed.
export default defineConfig({
  plugins: [react()],
  envDir: '..', // one .env at the repo root, shared with the Python engine
})
