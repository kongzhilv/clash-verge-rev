import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const target = process.argv[2]

if (!target) {
  throw new Error(
    'Usage: node scripts/build-matching-service.mjs <rust-target>',
  )
}

const isWindows = target.includes('windows-msvc')
const isLinux =
  target.includes('linux-gnu') || target.includes('linux-gnueabihf')
const extension = isWindows ? '.exe' : ''
const checkoutDir = path.join(rootDir, '.ci', `service-ipc-source-${target}`)
const reportPath = path.join(
  rootDir,
  '.ci',
  `service-ipc-build-info-${target}.txt`,
)

const run = (command, args, { allowFailure = false } = {}) => {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  })

  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
  return result.status ?? 1
}

const lockText = fs.readFileSync(path.join(rootDir, 'Cargo.lock'), 'utf8')
const dependency = lockText.match(
  /\[\[package\]\]\s*name = "clash_verge_service_ipc"\s*version = "([^"]+)"\s*source = "git\+https:\/\/github\.com\/clash-verge-rev\/clash-verge-service-ipc(?:\.git)?#([0-9a-f]+)"/ms,
)

if (!dependency) {
  throw new Error(
    'Unable to find clash_verge_service_ipc git revision in Cargo.lock',
  )
}

const [, expectedVersion, revision] = dependency
console.log(
  `Building clash-verge-service-ipc ${expectedVersion} from ${revision} for ${target}`,
)

fs.rmSync(checkoutDir, { recursive: true, force: true })
fs.mkdirSync(checkoutDir, { recursive: true })
fs.mkdirSync(path.dirname(reportPath), { recursive: true })

run('git', ['-C', checkoutDir, 'init'])
run('git', [
  '-C',
  checkoutDir,
  'remote',
  'add',
  'origin',
  'https://github.com/clash-verge-rev/clash-verge-service-ipc.git',
])
run('git', ['-C', checkoutDir, 'fetch', '--depth', '1', 'origin', revision])
run('git', ['-C', checkoutDir, 'checkout', '--detach', 'FETCH_HEAD'])

const manifestPath = path.join(checkoutDir, 'Cargo.toml')
const manifestText = fs.readFileSync(manifestPath, 'utf8')
const actualVersion = manifestText.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
if (!actualVersion) {
  throw new Error(
    'Unable to read service version from the checked-out Cargo.toml',
  )
}
if (actualVersion !== expectedVersion) {
  throw new Error(
    `Service source version ${actualVersion} does not match client lock version ${expectedVersion}`,
  )
}

run('rustup', ['target', 'add', target])

const cargoArgs = [
  'build',
  '--manifest-path',
  manifestPath,
  '--release',
  '--target',
  target,
  '--features',
  'standalone,client',
]

let buildStatus = run('cargo', [...cargoArgs, '--locked'], {
  allowFailure: true,
})
if (buildStatus !== 0) {
  console.warn(
    'Locked service build failed; retrying with the checked-out manifest lock refresh',
  )
  buildStatus = run('cargo', cargoArgs, { allowFailure: true })
}
if (buildStatus !== 0) {
  throw new Error(`Unable to build matching service for ${target}`)
}

const outputDir = path.join(checkoutDir, 'target', target, 'release')
const destinationDir = isLinux
  ? path.join(rootDir, 'src-tauri', 'sidecar')
  : path.join(rootDir, 'src-tauri', 'resources')
const binaryNames = [
  'clash-verge-service',
  'clash-verge-service-install',
  'clash-verge-service-uninstall',
]
const report = [
  `service_version=${actualVersion}`,
  `service_revision=${revision}`,
  `target=${target}`,
]

fs.mkdirSync(destinationDir, { recursive: true })

for (const binaryName of binaryNames) {
  const source = path.join(outputDir, `${binaryName}${extension}`)
  if (!fs.existsSync(source)) {
    throw new Error(`Expected service binary not found: ${source}`)
  }

  const destinationName = isLinux
    ? `${binaryName}-${target}`
    : `${binaryName}${extension}`
  const destination = path.join(destinationDir, destinationName)
  fs.copyFileSync(source, destination)
  if (!isWindows) fs.chmodSync(destination, 0o755)

  const hash = createHash('sha256')
    .update(fs.readFileSync(destination))
    .digest('hex')
  report.push(`${destinationName}=${hash}`)
  console.log(`Installed matching service binary: ${destination} (${hash})`)
}

fs.writeFileSync(reportPath, `${report.join('\n')}\n`, 'utf8')
console.log(`Service build information written to ${reportPath}`)
