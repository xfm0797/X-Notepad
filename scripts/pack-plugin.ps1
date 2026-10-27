<#
打包一个插件目录成市场用的 zip。

用法：
  powershell -File scripts/pack-plugin.ps1 -PluginDir plugins/csv-viewer

产物：dist-plugins/<id>.zip，里面只有 plugin.json 和清单里 entry 指向的 wasm。
#>
param(
    [Parameter(Mandatory = $true)][string]$PluginDir,
    [string]$OutDir = "dist-plugins"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PluginDir)) { throw "插件目录不存在：$PluginDir" }

$manifestPath = Join-Path $PluginDir "plugin.json"
if (-not (Test-Path $manifestPath)) { throw "缺少 plugin.json：$manifestPath" }

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = if ($manifest.entry) { $manifest.entry } else { "plugin.wasm" }
$wasmPath = Join-Path $PluginDir $entry
if (-not (Test-Path $wasmPath)) { throw "缺少 $entry，先跑一遍构建脚本" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("xnp-pack-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
    Copy-Item $manifestPath (Join-Path $stage "plugin.json")
    Copy-Item $wasmPath (Join-Path $stage $entry)
    # README / LICENSE 之类的一起带上，体积可忽略
    foreach ($extra in @("README.md", "LICENSE")) {
        $p = Join-Path $PluginDir $extra
        if (Test-Path $p) { Copy-Item $p (Join-Path $stage $extra) }
    }

    $zip = Join-Path (Resolve-Path $OutDir) ("{0}.zip" -f $manifest.id)
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

    $size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
    Write-Host "已生成 $zip ($size KB)"
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
