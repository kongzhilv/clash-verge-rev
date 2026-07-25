import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const requestedTarget = process.argv[2]

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

const prebuildArgs = [path.join(scriptDir, 'prebuild.mjs')]
if (requestedTarget) prebuildArgs.push(requestedTarget)
run(process.execPath, prebuildArgs)

const isWindowsTarget =
  process.platform === 'win32' &&
  (!requestedTarget || requestedTarget.includes('windows-msvc'))

if (isWindowsTarget) {
  const target =
    requestedTarget ??
    (process.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : 'x86_64-pc-windows-msvc')

  run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(scriptDir, 'build-matching-service.ps1'),
    '-Target',
    target,
  ])
}
