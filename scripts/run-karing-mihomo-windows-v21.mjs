import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const MIHOMO_NETWORK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000]
const TRANSIENT_GO_NETWORK_PATTERNS = [
  /stream error: stream ID \d+; INTERNAL_ERROR/i,
  /TLS handshake timeout/i,
  /unexpected EOF/i,
  /connection reset by peer/i,
  /connection refused/i,
  /\bi\/o timeout\b/i,
  /\bdial tcp\b.*(?:timeout|refused)/i,
  /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/i,
  /temporary failure in name resolution/i,
]

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function createGoNetworkFallbackEnv(env) {
  const settings = (env.GODEBUG ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith('http2client='))
  const currentGoProxy = env.GOPROXY?.trim()
  const retryGoProxy =
    !currentGoProxy || currentGoProxy === 'https://proxy.golang.org,direct'
      ? 'https://proxy.golang.org|direct'
      : currentGoProxy

  return {
    ...env,
    GODEBUG: [...settings, 'http2client=0'].join(','),
    GOPROXY: retryGoProxy,
  }
}

export function runPatchedMihomoBuilder(buildTarget) {
  if (!buildTarget) throw new Error('patched Windows Mihomo target is required')

  const builder = path.join(scriptsDir, 'build-karing-mihomo-windows-v21.mjs')
  const maxAttempts = MIHOMO_NETWORK_RETRY_DELAYS_MS.length + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const env =
      attempt === 1
        ? { ...process.env }
        : createGoNetworkFallbackEnv(process.env)
    const result = spawnSync(process.execPath, [builder, buildTarget], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: 'pipe',
    })

    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status === 0) return

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const transientNetworkFailure = TRANSIENT_GO_NETWORK_PATTERNS.some(
      (pattern) => pattern.test(output),
    )
    if (!transientNetworkFailure || attempt === maxAttempts) {
      throw new Error(
        `patched Windows Mihomo build failed for ${buildTarget} with exit code ${result.status}`,
      )
    }

    const delay = MIHOMO_NETWORK_RETRY_DELAYS_MS[attempt - 1]
    console.warn(
      `[retry] transient Go module/network failure while building ${buildTarget}; attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms with HTTP/2 disabled and proxy error fallback enabled`,
    )
    sleepSync(delay)
  }
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  runPatchedMihomoBuilder(process.argv[2])
}
