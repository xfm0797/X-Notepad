<#
打包一个插件目录成市场用的 zip。

用法：
  powershell -File scripts/pack-plugin.ps1 -PluginDir plugins/csv-viewer
  powershell -File scripts/pack-plugin.ps1 -PluginDir plugins/csv-viewer -KeyPath "$HOME/.xnp-signing/xfm-official.json"

带 -KeyPath 时先给暂存目录签名（scripts/sign-plugin.mjs），signature.json 一起打进 zip。

产物：dist-plugins/<id>.zip，里面是 plugin.json、清单 entry 指向的 wasm、
README/LICENSE（有的话），以及 signature.json（签过的话）。
#>
param(
    [Parameter(Mandatory = $true)][string]$PluginDir,
    [string]$OutDir = "dist-plugins",
    [string]$KeyPath = ""
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

    # 签名要在压缩之前做：摘要算的是暂存目录里这几个文件，
    # 跟解包后落到插件目录的内容一模一样，验签才对得上。
    if ($KeyPath) {
        if (-not (Test-Path $KeyPath)) { throw "找不到私钥文件：$KeyPath" }
        $signer = Join-Path $PSScriptRoot "sign-plugin.mjs"
        node $signer sign $stage --key $KeyPath
        if ($LASTEXITCODE -ne 0) { throw "签名失败" }
    }
    else {
        Write-Host "提示：没带 -KeyPath，这个包不会签名（客户端会标「未签名」）" -ForegroundColor Yellow
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
