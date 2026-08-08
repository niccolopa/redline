/**
 * One command starts the whole stack: risk engine, oracle, and the dev server.
 *
 *   npm run dev              LIVE ETH/USD from the Binance public API
 *   npm run demo             historical crash replay (the one that redlines)
 *
 * This is a launcher rather than a Vite plugin on purpose. Vite restarts itself
 * whenever its config changes, and each restart re-ran the backend: a second
 * oracle replayed the feed from bar 0 and posted bars the contract had already
 * seen, which silently corrupts the on-chain HMM (its belief is a recursion, so
 * a repeated observation is not idempotent). One parent owning all three
 * children has no restart semantics to get wrong.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const ROOT = resolve(HERE, '..')

const PYTHON = [
  resolve(ROOT, '.venv/Scripts/python.exe'),
  resolve(ROOT, '.venv/bin/python'),
].find(existsSync) ?? 'python'

const replay = process.argv.includes('--replay')
const children = []

// Vite's own entry point, run with this same Node binary. Spawning the `vite`
// / `npx` .cmd shim instead fails with EINVAL on Windows unless a shell is
// used, and a shell brings back the arg-escaping hazard (DEP0190).
const VITE_BIN = resolve(HERE, 'node_modules/vite/bin/vite.js')

function start(name, command, args, cwd, color) {
  // No shell: passing args through a shell is a quoting/injection hazard and
  // Node deprecates it (DEP0190). Windows needs the .cmd shim spelled out.
  const child = spawn(command, args, { cwd })
  children.push(child)
  const pipe = (buf) =>
    String(buf).split('\n').filter(Boolean)
      .forEach((line) => console.log(`${color}[${name}]\x1b[0m ${line}`))
  child.stdout.on('data', pipe)
  child.stderr.on('data', pipe)
  child.on('exit', (code) => {
    console.log(`${color}[${name}]\x1b[0m exited (${code})`)
    if (name !== 'vite') shutdown(1)   // engine or oracle dying makes the UI a lie
  })
  return child
}

let closing = false
function shutdown(code = 0) {
  if (closing) return
  closing = true
  children.forEach((c) => !c.killed && c.kill())
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('exit', () => children.forEach((c) => !c.killed && c.kill()))

console.log(`\n\x1b[31m REDLINE \x1b[0m ${replay
  ? 'REPLAY — historical crash from data/crash.csv'
  : 'LIVE — ETH/USDT from the Binance public API'}`)
console.log(`\x1b[90m python: ${PYTHON}\x1b[0m\n`)

start('engine', PYTHON, ['-u', 'engine/risk_engine.py', ...(replay ? ['--replay'] : [])], ROOT, '\x1b[36m')

// The oracle reads the feed from bar 0; the engine truncates that file when it
// starts, so give it a moment or the oracle races an empty file.
setTimeout(() => {
  if (!closing) start('oracle', PYTHON, ['-u', 'engine/oracle.py'], ROOT, '\x1b[33m')
}, 5000)

start('vite', process.execPath, [VITE_BIN], HERE, '\x1b[35m')
