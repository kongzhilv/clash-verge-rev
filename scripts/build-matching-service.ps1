param(
  [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lockPath = Join-Path $root 'Cargo.lock'
$lock = Get-Content -LiteralPath $lockPath -Raw

$pattern = '(?ms)\[\[package\]\]\s*name = "clash_verge_service_ipc"\s*version = "([^"]+)"\s*source = "git\+https://github\.com/clash-verge-rev/clash-verge-service-ipc#([0-9a-f]+)"'
$match = [regex]::Match($lock, $pattern)
if (-not $match.Success) {
  throw 'Unable to find clash_verge_service_ipc git revision in Cargo.lock'
}

$expectedVersion = $match.Groups[1].Value
$revision = $match.Groups[2].Value
$checkoutDir = Join-Path $root '.ci/service-ipc-source'
$resourcesDir = Join-Path $root 'src-tauri/resources'
$buildInfoPath = Join-Path $root '.ci/service-ipc-build-info.txt'

Write-Host "Building clash-verge-service-ipc $expectedVersion from $revision for $Target"

Remove-Item -LiteralPath $checkoutDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $checkoutDir -Force | Out-Null
New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $buildInfoPath) -Force | Out-Null

git -C $checkoutDir init
git -C $checkoutDir remote add origin https://github.com/clash-verge-rev/clash-verge-service-ipc.git
git -C $checkoutDir fetch --depth 1 origin $revision
git -C $checkoutDir checkout --detach FETCH_HEAD

$serviceManifest = Join-Path $checkoutDir 'Cargo.toml'
$manifestText = Get-Content -LiteralPath $serviceManifest -Raw
$versionMatch = [regex]::Match($manifestText, '(?m)^version\s*=\s*"([^"]+)"')
if (-not $versionMatch.Success) {
  throw 'Unable to read service version from the checked-out Cargo.toml'
}
$actualVersion = $versionMatch.Groups[1].Value
if ($actualVersion -ne $expectedVersion) {
  throw "Service source version $actualVersion does not match client lock version $expectedVersion"
}

rustup target add $Target
cargo build --manifest-path $serviceManifest --release --target $Target --features standalone --locked

$outputDir = Join-Path $checkoutDir "target/$Target/release"
$binaryNames = @(
  'clash-verge-service.exe',
  'clash-verge-service-install.exe',
  'clash-verge-service-uninstall.exe'
)

$report = @(
  "service_version=$actualVersion",
  "service_revision=$revision",
  "target=$Target"
)

foreach ($binaryName in $binaryNames) {
  $source = Join-Path $outputDir $binaryName
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Expected service binary not found: $source"
  }

  $destination = Join-Path $resourcesDir $binaryName
  Copy-Item -LiteralPath $source -Destination $destination -Force
  $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  $report += "$binaryName=$hash"
  Write-Host "Installed matching service binary: $destination ($hash)"
}

$report | Set-Content -LiteralPath $buildInfoPath -Encoding utf8
Write-Host "Service build information written to $buildInfoPath"
