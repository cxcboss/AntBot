$ErrorActionPreference = 'Stop'

param(
  [string]$OutputDir = "",
  [switch]$SkipBackendBuild
)

$RootDir = Split-Path -Parent $PSScriptRoot
$FlutterDir = Join-Path $RootDir 'clients\antbot_flutter'
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $RootDir 'release_flutter_windows'
}

function Invoke-RobocopyMirror {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & robocopy $Source $Destination /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
  }
}

Push-Location $RootDir
try {
  if (-not $SkipBackendBuild) {
    Write-Host '[build-flutter-windows] building packaged Electron backend...'
    npm run build:win
  } else {
    Write-Host '[build-flutter-windows] skipping Electron backend build'
  }

  $BackendDir = Join-Path $RootDir 'release\win-unpacked'
  $BackendExe = Join-Path $BackendDir '搬运蚁.exe'
  if (-not (Test-Path $BackendExe)) {
    throw "backend exe not found: $BackendExe"
  }

  Push-Location $FlutterDir
  try {
    Write-Host '[build-flutter-windows] resolving Flutter packages...'
    flutter pub get

    Write-Host '[build-flutter-windows] building Flutter windows app...'
    flutter build windows --release
  } finally {
    Pop-Location
  }

  $VersionLine = Select-String -Path (Join-Path $FlutterDir 'pubspec.yaml') -Pattern '^version:\s*(.+)$'
  if (-not $VersionLine) {
    throw 'version not found in pubspec.yaml'
  }
  $Version = $VersionLine.Matches[0].Groups[1].Value.Split('+')[0]

  $AppDir = Join-Path $FlutterDir 'build\windows\x64\runner\Release'
  $FlutterExe = Join-Path $AppDir 'antbot_flutter.exe'
  if (-not (Test-Path $FlutterExe)) {
    throw "flutter exe not found: $FlutterExe"
  }

  $EmbeddedBackendDir = Join-Path $AppDir 'data\backend'
  if (Test-Path $EmbeddedBackendDir) {
    Remove-Item -Recurse -Force $EmbeddedBackendDir
  }

  Write-Host '[build-flutter-windows] embedding backend...'
  Invoke-RobocopyMirror -Source $BackendDir -Destination $EmbeddedBackendDir

  Write-Host '[build-flutter-windows] preparing separate output directory...'
  if (Test-Path $OutputDir) {
    Remove-Item -Recurse -Force $OutputDir
  }
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  $PortableDir = Join-Path $OutputDir '搬运蚁 Flutter'
  Invoke-RobocopyMirror -Source $AppDir -Destination $PortableDir

  $ZipPath = Join-Path $OutputDir "搬运蚁-Flutter-$Version-win-x64.zip"
  if (Test-Path $ZipPath) {
    Remove-Item -Force $ZipPath
  }

  Write-Host '[build-flutter-windows] creating zip artifact...'
  Compress-Archive -Path $PortableDir -DestinationPath $ZipPath -CompressionLevel Optimal

  Write-Host '[build-flutter-windows] done'
  Write-Host "[build-flutter-windows] app: $PortableDir"
  Write-Host "[build-flutter-windows] zip: $ZipPath"
} finally {
  Pop-Location
}
