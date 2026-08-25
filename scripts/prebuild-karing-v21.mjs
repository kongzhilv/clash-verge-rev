import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv.slice(2).find((arg) => !arg.startsWith('-'))
const patchedWindowsTargets = new Set([
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
])

if (patchedWindowsTargets.has(target)) {
  if (process.platform !== 'win32') {
    throw new Error(
      `patched Windows Mihomo core must be built on a Windows runner: ${target}`,
    )
  }
  execFileSync(
    process.execPath,
    [path.join(scriptsDir, 'build-karing-mihomo-windows-v21.mjs'), target],
    { stdio: 'inherit' },
  )
}

await import('./prebuild.mjs')
