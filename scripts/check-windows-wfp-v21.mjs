import fs from 'node:fs'

function mustContain(text, token, label) {
  if (!text.includes(token)) throw new Error(`${label}: missing ${token}`)
}

function mustNotContain(text, token, label) {
  if (text.includes(token)) throw new Error(`${label}: forbidden ${token}`)
}

function pushEventBlock(text, label) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line === '  push:')
  if (start < 0) throw new Error(`${label}: missing push event`)

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line && !line.startsWith(' ')) {
      end = index
      break
    }
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const build = fs.readFileSync(
  'scripts/build-karing-mihomo-windows-v21.mjs',
  'utf8',
)
const runner = fs.readFileSync(
  'scripts/run-karing-mihomo-windows-v21.mjs',
  'utf8',
)
const wrapper = fs.readFileSync('scripts/prebuild-karing-v21.mjs', 'utf8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const provenance = JSON.parse(
  fs.readFileSync('.release/karing-windows-mihomo-v21.json', 'utf8'),
)

for (const [label, token] of [
  ['stable Mihomo pin', 'ac017cdd246ce8bd547653d927e7bf77d7ee73d5'],
  ['alpha Mihomo pin', 'fb66af813b3e65023851e94166ec8a4f61e02634'],
  ['sing-tun pin', 'dfc71de64aed159d9a09a5df43077bab0671db1f'],
  ['sing-tun version', 'v0.4.22'],
  ['WFP condition', 'FWPM_CONDITION_FLAGS'],
  ['non-loopback match', 'FWP_MATCH_FLAGS_NONE_SET'],
  ['loopback flag', 'FWP_CONDITION_FLAG_IS_LOOPBACK'],
  ['condition count', 'blockFilter.NumFilterConditions = 1'],
  ['ALE connect v6', 'FWPM_LAYER_ALE_AUTH_CONNECT_V6'],
  ['stable sidecar', 'verge-mihomo'],
  ['alpha sidecar', 'verge-mihomo-alpha'],
  [
    'pinned Go 1.20.14',
    '0e0d0190406ead891d94ecf00f961bb5cfa15ddd47499d2649f12eee80aee110',
  ],
]) {
  mustContain(build, token, label)
}

for (const [label, token] of [
  ['bounded transient retry delays', 'MIHOMO_NETWORK_RETRY_DELAYS_MS'],
  ['transient Go network classifier', 'TRANSIENT_GO_NETWORK_PATTERNS'],
  ['HTTP/2 fallback after transient failure', 'http2client=0'],
  [
    'proxy any-error fallback after transient failure',
    'https://proxy.golang.org|direct',
  ],
  ['shared builder retry entrypoint', 'runPatchedMihomoBuilder'],
  ['actual pinned builder invocation', 'build-karing-mihomo-windows-v21.mjs'],
]) {
  mustContain(runner, token, label)
}

for (const [label, token] of [
  ['prebuild safety gate', 'check-windows-wfp-v21.mjs'],
  ['shared retry runner', 'run-karing-mihomo-windows-v21.mjs'],
  ['shared retry call', 'runPatchedMihomoBuilder(target)'],
]) {
  mustContain(wrapper, token, label)
}
mustNotContain(
  wrapper,
  'MIHOMO_NETWORK_RETRY_DELAYS_MS',
  'prebuild retry policy duplication',
)
mustContain(wrapper, "await import('./prebuild.mjs')", 'prebuild fallback')
if (pkg.scripts.prebuild !== 'node scripts/prebuild-karing-v21.mjs') {
  throw new Error(
    `package prebuild is not v21 wrapper: ${pkg.scripts.prebuild}`,
  )
}

const releaseGateInputs = [
  '.github/workflows/karing-diagnostics-once.yml',
  'src/**',
  'src-tauri/**',
  'crates/**',
  'scripts/**',
  'package.json',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'Cargo.lock',
  '.cargo/**',
  '.release/karing-release-tag.txt',
  '.release/karing-release-authorize.txt',
]
for (const [label, workflow, ownWorkflowPath] of [
  [
    'WFP v21 workflow',
    '.github/workflows/karing-windows-wfp-v21.yml',
    '.github/workflows/karing-windows-wfp-v21.yml',
  ],
  [
    'Hotspot v27 workflow',
    '.github/workflows/karing-windows-hotspot-v26.yml',
    '.github/workflows/karing-windows-hotspot-v26.yml',
  ],
]) {
  const workflowText = fs.readFileSync(workflow, 'utf8')
  const pushBlock = pushEventBlock(workflowText, label)
  mustContain(
    pushBlock,
    `- '${ownWorkflowPath}'`,
    `${label} own workflow input`,
  )
  for (const releaseInput of releaseGateInputs) {
    mustContain(pushBlock, `- '${releaseInput}'`, `${label} release input`)
  }
  mustNotContain(pushBlock, "- '.release/**'", `${label} broad release trigger`)
}

const observerWorkflow = fs.readFileSync(
  '.github/workflows/karing-release-observer.yml',
  'utf8',
)
const observerPushBlock = pushEventBlock(observerWorkflow, 'release observer')
const observerPaths = [
  ...observerPushBlock.matchAll(/^\s+- '([^']+)'\s*$/gm),
].map((match) => match[1])
if (
  observerPaths.length !== 1 ||
  observerPaths[0] !== '.release/karing-release-authorize.txt'
) {
  throw new Error(
    `release observer: expected authorize-only push path, got ${observerPaths.join(', ')}`,
  )
}

const wfpWorkflow = fs.readFileSync(
  '.github/workflows/karing-windows-wfp-v21.yml',
  'utf8',
)
mustContain(
  wfpWorkflow,
  'node scripts/run-karing-mihomo-windows-v21.mjs ${{ matrix.target }}',
  'WFP workflow shared retry runner',
)
mustNotContain(
  wfpWorkflow,
  'run: node scripts/build-karing-mihomo-windows-v21.mjs ${{ matrix.target }}',
  'WFP workflow direct builder bypass',
)

mustNotContain(build, 'FWP_MATCH_FLAGS_ALL_SET', 'v21 block semantics')
if (provenance.policy !== 'block-non-loopback-ipv6') {
  throw new Error(`unexpected provenance policy: ${provenance.policy}`)
}
if (provenance.wfp?.loopback !== 'permit') {
  throw new Error('provenance must state loopback=permit')
}
if (provenance.wfp?.nonLoopbackIPv6 !== 'block-when-ipv6-disabled') {
  throw new Error('provenance must retain non-loopback IPv6 blocking')
}

console.log('Karing Windows WFP v21 safety gate passed')
