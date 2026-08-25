import fs from 'node:fs'

function mustContain(text, token, label) {
  if (!text.includes(token)) throw new Error(`${label}: missing ${token}`)
}

function mustNotContain(text, token, label) {
  if (text.includes(token)) throw new Error(`${label}: forbidden ${token}`)
}

const build = fs.readFileSync(
  'scripts/build-karing-mihomo-windows-v21.mjs',
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

mustContain(wrapper, 'check-windows-wfp-v21.mjs', 'prebuild safety gate')
mustContain(wrapper, 'build-karing-mihomo-windows-v21.mjs', 'prebuild wrapper')
mustContain(wrapper, "await import('./prebuild.mjs')", 'prebuild fallback')
if (pkg.scripts.prebuild !== 'node scripts/prebuild-karing-v21.mjs') {
  throw new Error(
    `package prebuild is not v21 wrapper: ${pkg.scripts.prebuild}`,
  )
}

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
