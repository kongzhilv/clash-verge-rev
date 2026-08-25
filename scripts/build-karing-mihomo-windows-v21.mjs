import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import AdmZip from 'adm-zip'

const cwd = process.cwd()
const target = process.argv[2]

const TARGETS = {
  'x86_64-pc-windows-msvc': { goarch: 'amd64', goamd64: 'v2' },
  'aarch64-pc-windows-msvc': { goarch: 'arm64' },
}

const PINS = Object.freeze({
  mihomoStable: 'ac017cdd246ce8bd547653d927e7bf77d7ee73d5',
  mihomoAlpha: 'fb66af813b3e65023851e94166ec8a4f61e02634',
  singTun: 'dfc71de64aed159d9a09a5df43077bab0671db1f',
  singTunVersion: 'v0.4.22',
})

const GO_TOOLCHAIN = Object.freeze({
  version: '1.20.14',
  url: 'https://dl.google.com/go/go1.20.14.windows-amd64.zip',
  sha256: '0e0d0190406ead891d94ecf00f961bb5cfa15ddd47499d2649f12eee80aee110',
})

const PATCH_POLICY = 'block-non-loopback-ipv6'
const PATCH_GUID = '632ce23b-5167-435c-86d7-e903684aa80c'
const workspace = path.join(cwd, '.ci', 'mihomo-wfp-v21', target || 'unknown')
const toolchainRoot = path.join(cwd, '.ci', 'toolchains', `go${GO_TOOLCHAIN.version}`)

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...options,
  })
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected source block exactly once`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

async function ensureGoToolchain() {
  const goExe = path.join(toolchainRoot, 'go', 'bin', 'go.exe')
  if (fs.existsSync(goExe)) return goExe

  const zipPath = path.join(
    toolchainRoot,
    `go${GO_TOOLCHAIN.version}.windows-amd64.zip`,
  )
  await fsp.mkdir(toolchainRoot, { recursive: true })

  const response = await fetch(GO_TOOLCHAIN.url)
  if (!response.ok) {
    throw new Error(
      `failed to download Go ${GO_TOOLCHAIN.version}: HTTP ${response.status}`,
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== GO_TOOLCHAIN.sha256) {
    throw new Error(
      `Go toolchain SHA256 mismatch: expected ${GO_TOOLCHAIN.sha256}, got ${digest}`,
    )
  }
  await fsp.writeFile(zipPath, bytes)
  new AdmZip(zipPath).extractAllTo(toolchainRoot, true)
  await fsp.rm(zipPath, { force: true })

  const version = run(goExe, ['version'], { capture: true }).trim()
  if (!version.includes(`go${GO_TOOLCHAIN.version}`)) {
    throw new Error(`unexpected Go toolchain: ${version}`)
  }
  return goExe
}

function clonePinned(repoUrl, commit, destination) {
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  run('git', ['init', '--quiet'], { cwd: destination })
  run('git', ['remote', 'add', 'origin', repoUrl], { cwd: destination })
  run('git', ['fetch', '--quiet', '--depth=1', 'origin', commit], {
    cwd: destination,
  })
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], {
    cwd: destination,
  })
  const actual = run('git', ['rev-parse', 'HEAD'], {
    cwd: destination,
    capture: true,
  }).trim()
  if (actual !== commit) {
    throw new Error(
      `pinned source mismatch for ${repoUrl}: expected ${commit}, got ${actual}`,
    )
  }
}

function patchSingTun(singTunDir, goExe) {
  const constantsPath = path.join(
    singTunDir,
    'internal',
    'winsys',
    'constants.go',
  )
  const tunPath = path.join(singTunDir, 'tun_windows.go')

  let constants = fs.readFileSync(constantsPath, 'utf8')
  const constantsMarker = `const (\n\tIPPROTO_UDP uint32 = 17\n)\n`
  const constantsPatch = `const (\n\tFWP_CONDITION_FLAG_IS_LOOPBACK uint32 = 0x00000001\n)\n\n// 632ce23b-5167-435c-86d7-e903684aa80c\nvar FWPM_CONDITION_FLAGS = windows.GUID{\n\tData1: 0x632ce23b,\n\tData2: 0x5167,\n\tData3: 0x435c,\n\tData4: [8]byte{0x86, 0xd7, 0xe9, 0x03, 0x68, 0x4a, 0xa8, 0x0c},\n}\n\n${constantsMarker}`
  if (
    constants.includes('FWP_CONDITION_FLAG_IS_LOOPBACK') ||
    constants.includes('FWPM_CONDITION_FLAGS')
  ) {
    throw new Error(
      'sing-tun source already contains loopback symbols; re-audit patch before release',
    )
  }
  constants = replaceExactlyOnce(
    constants,
    constantsMarker,
    constantsPatch,
    'sing-tun constants patch',
  )
  fs.writeFileSync(constantsPath, constants)

  let tun = fs.readFileSync(tunPath, 'utf8')
  const oldBlock = `\t\tif len(t.options.Inet6Address) == 0 {\n\t\t\tblockFilter := winsys.FWPM_FILTER0{}\n\t\t\tblockFilter.DisplayData = winsys.CreateDisplayData(TunnelType, "block ipv6")\n\t\t\tblockFilter.SubLayerKey = subLayerKey\n\t\t\tblockFilter.LayerKey = winsys.FWPM_LAYER_ALE_AUTH_CONNECT_V6\n\t\t\tblockFilter.Action.Type = winsys.FWP_ACTION_BLOCK\n\t\t\tblockFilter.Weight.Type = winsys.FWP_UINT8\n\t\t\tblockFilter.Weight.Value = uintptr(12)\n\t\t\terr = winsys.FwpmFilterAdd0(engine, &blockFilter, 0, &filterId)\n\t\t\tif err != nil {\n\t\t\t\treturn os.NewSyscallError("FwpmFilterAdd0", err)\n\t\t\t}\n\t\t}\n`
  const newBlock = `\t\tif len(t.options.Inet6Address) == 0 {\n\t\t\tblockIPv6Condition := make([]winsys.FWPM_FILTER_CONDITION0, 1)\n\t\t\tblockIPv6Condition[0].FieldKey = winsys.FWPM_CONDITION_FLAGS\n\t\t\tblockIPv6Condition[0].MatchType = winsys.FWP_MATCH_FLAGS_NONE_SET\n\t\t\tblockIPv6Condition[0].ConditionValue.Type = winsys.FWP_UINT32\n\t\t\tblockIPv6Condition[0].ConditionValue.Value = uintptr(uint32(winsys.FWP_CONDITION_FLAG_IS_LOOPBACK))\n\n\t\t\tblockFilter := winsys.FWPM_FILTER0{}\n\t\t\tblockFilter.FilterCondition = &blockIPv6Condition[0]\n\t\t\tblockFilter.NumFilterConditions = 1\n\t\t\tblockFilter.DisplayData = winsys.CreateDisplayData(TunnelType, "block ipv6")\n\t\t\tblockFilter.SubLayerKey = subLayerKey\n\t\t\tblockFilter.LayerKey = winsys.FWPM_LAYER_ALE_AUTH_CONNECT_V6\n\t\t\tblockFilter.Action.Type = winsys.FWP_ACTION_BLOCK\n\t\t\tblockFilter.Weight.Type = winsys.FWP_UINT8\n\t\t\tblockFilter.Weight.Value = uintptr(12)\n\t\t\terr = winsys.FwpmFilterAdd0(engine, &blockFilter, 0, &filterId)\n\t\t\tif err != nil {\n\t\t\t\treturn os.NewSyscallError("FwpmFilterAdd0", err)\n\t\t\t}\n\t\t}\n`
  tun = replaceExactlyOnce(
    tun,
    oldBlock,
    newBlock,
    'sing-tun IPv6 WFP block patch',
  )
  fs.writeFileSync(tunPath, tun)

  run(goExe, ['fmt', constantsPath, tunPath], { cwd: singTunDir })

  const patchedTun = fs.readFileSync(tunPath, 'utf8')
  for (const token of [
    'FWPM_CONDITION_FLAGS',
    'FWP_MATCH_FLAGS_NONE_SET',
    'FWP_CONDITION_FLAG_IS_LOOPBACK',
    'blockFilter.NumFilterConditions = 1',
  ]) {
    if (!patchedTun.includes(token)) {
      throw new Error(`patched sing-tun missing ${token}`)
    }
  }
  return {
    constantsSha256: sha256File(constantsPath),
    tunWindowsSha256: sha256File(tunPath),
  }
}

function buildMihomo({ name, commit, version }, singTunDir, goExe, targetInfo) {
  const sourceDir = path.join(workspace, `mihomo-${name}`)
  clonePinned('https://github.com/MetaCubeX/mihomo.git', commit, sourceDir)

  const goMod = fs.readFileSync(path.join(sourceDir, 'go.mod'), 'utf8')
  const expectedDependency =
    `github.com/metacubex/sing-tun ${PINS.singTunVersion}`
  if (!goMod.includes(expectedDependency)) {
    throw new Error(
      `${name}: expected ${expectedDependency}; upstream dependency changed, re-audit required`,
    )
  }

  const env = {
    ...process.env,
    GOOS: 'windows',
    GOARCH: targetInfo.goarch,
    CGO_ENABLED: '0',
    GOTOOLCHAIN: 'local',
  }
  if (targetInfo.goamd64) env.GOAMD64 = targetInfo.goamd64

  run(
    goExe,
    ['mod', 'edit', `-replace=github.com/metacubex/sing-tun=${singTunDir}`],
    { cwd: sourceDir, env },
  )

  const outputName = name === 'stable' ? 'verge-mihomo' : 'verge-mihomo-alpha'
  const outputPath = path.join(
    cwd,
    'src-tauri',
    'sidecar',
    `${outputName}-${target}.exe`,
  )
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const buildTime = '2026-08-25T00:00:00Z'
  const ldflags = `-extldflags --static -X github.com/metacubex/mihomo/constant.Version=${version} -X github.com/metacubex/mihomo/constant.BuildTime=${buildTime} -w -s -buildid=`
  run(
    goExe,
    [
      'build',
      '-tags',
      'with_gvisor',
      '-trimpath',
      '-ldflags',
      ldflags,
      '-o',
      outputPath,
      '.',
    ],
    { cwd: sourceDir, env },
  )

  const moduleInfo = run(goExe, ['version', '-m', outputPath], {
    capture: true,
  })
  if (
    !moduleInfo.includes('github.com/metacubex/sing-tun') ||
    !moduleInfo.includes('=>')
  ) {
    throw new Error(
      `${name}: built binary does not record the local sing-tun replacement`,
    )
  }

  let runtimeVersion = null
  if (targetInfo.goarch === 'amd64' && process.arch === 'x64') {
    runtimeVersion = run(outputPath, ['-v'], { capture: true }).trim()
    if (!runtimeVersion.includes(version)) {
      throw new Error(`${name}: unexpected runtime version: ${runtimeVersion}`)
    }
  }

  return {
    name,
    commit,
    version,
    target,
    sha256: sha256File(outputPath),
    output: path.relative(cwd, outputPath).replaceAll('\\', '/'),
    runtimeVersion,
    moduleInfo,
  }
}

async function main() {
  if (!TARGETS[target]) {
    throw new Error(`unsupported v21 patched Mihomo target: ${target}`)
  }
  if (process.platform !== 'win32') {
    throw new Error(
      `v21 patched Windows core builder must run on Windows, got ${process.platform}`,
    )
  }

  await fsp.rm(workspace, { recursive: true, force: true })
  await fsp.mkdir(workspace, { recursive: true })

  const goExe = await ensureGoToolchain()
  const singTunDir = path.join(workspace, 'sing-tun')
  clonePinned(
    'https://github.com/MetaCubeX/sing-tun.git',
    PINS.singTun,
    singTunDir,
  )
  const patchHashes = patchSingTun(singTunDir, goExe)
  const targetInfo = TARGETS[target]

  const stable = buildMihomo(
    {
      name: 'stable',
      commit: PINS.mihomoStable,
      version: 'v1.19.30-karing.21-wfp-loopback',
    },
    singTunDir,
    goExe,
    targetInfo,
  )
  const alpha = buildMihomo(
    {
      name: 'alpha',
      commit: PINS.mihomoAlpha,
      version: `alpha-${PINS.mihomoAlpha.slice(0, 7)}-karing.21-wfp-loopback`,
    },
    singTunDir,
    goExe,
    targetInfo,
  )

  const provenance = {
    schema: 1,
    policy: PATCH_POLICY,
    wfp: {
      layer: 'FWPM_LAYER_ALE_AUTH_CONNECT_V6',
      condition: 'FWPM_CONDITION_FLAGS',
      match: 'FWP_MATCH_FLAGS_NONE_SET',
      flag: 'FWP_CONDITION_FLAG_IS_LOOPBACK',
      conditionGuid: PATCH_GUID,
      semantics: 'block IPv6 only when the WFP loopback flag is not set',
    },
    source: PINS,
    goToolchain: GO_TOOLCHAIN,
    patchHashes,
    binaries: [stable, alpha],
  }
  const provenancePath = path.join(
    cwd,
    '.ci',
    `karing-mihomo-wfp-v21-${target}.json`,
  )
  await fsp.mkdir(path.dirname(provenancePath), { recursive: true })
  await fsp.writeFile(
    provenancePath,
    `${JSON.stringify(provenance, null, 2)}\n`,
  )
  console.log(JSON.stringify(provenance, null, 2))
}

await main()
