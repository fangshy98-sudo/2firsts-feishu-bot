param(
  [string]$HasReportDate = '2026-03-20',
  [string]$NoReportDate = '2026-03-18'
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$previewDir = Join-Path $scriptDir 'preview'
New-Item -ItemType Directory -Force -Path $previewDir | Out-Null

function Read-Utf8Json {
  param([Parameter(Mandatory = $true)][string]$Path)

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $text = [System.IO.File]::ReadAllText($Path, $utf8)
  return $text | ConvertFrom-Json
}

function Invoke-Scenario {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$TargetDate,
    [Parameter(Mandatory = $true)][string]$ExpectedMode
  )

  Write-Host "`n=== $Name ===" -ForegroundColor Cyan
  Write-Host "TARGET_DATE=$TargetDate"
  Write-Host "EXPECTED_MODE=$ExpectedMode"

  $env:TARGET_DATE = $TargetDate
  $env:PREVIEW_ONLY = 'true'

  node .\index.js
  if ($LASTEXITCODE -ne 0) {
    throw "index.js run failed for $Name (TARGET_DATE=$TargetDate)"
  }

  $latestJsonPath = Join-Path $previewDir 'latest.json'
  $latestMdPath = Join-Path $previewDir 'latest.md'

  if (-not (Test-Path $latestJsonPath)) {
    throw "preview/latest.json not found after $Name"
  }

  $result = Read-Utf8Json -Path $latestJsonPath

  $jsonOut = Join-Path $previewDir ("{0}-{1}.json" -f $Name, $TargetDate)
  $mdOut = Join-Path $previewDir ("{0}-{1}.md" -f $Name, $TargetDate)

  Copy-Item $latestJsonPath $jsonOut -Force
  if (Test-Path $latestMdPath) {
    Copy-Item $latestMdPath $mdOut -Force
  }

  $modeOk = $result.mode -eq $ExpectedMode
  $status = if ($modeOk) { 'PASS' } else { 'WARN' }
  $color = if ($modeOk) { 'Green' } else { 'Yellow' }

  Write-Host ("[{0}] mode={1} itemCount={2}" -f $status, $result.mode, $result.itemCount) -ForegroundColor $color
  Write-Host ("saved: {0}" -f $jsonOut)

  if (-not $modeOk) {
    Write-Host ("expected mode {0}, actual mode {1}" -f $ExpectedMode, $result.mode) -ForegroundColor Yellow
  }

  [PSCustomObject]@{
    name = $Name
    targetDate = $TargetDate
    expectedMode = $ExpectedMode
    actualMode = $result.mode
    itemCount = $result.itemCount
    ok = $modeOk
    jsonPath = $jsonOut
  }
}

$results = @()
$results += Invoke-Scenario -Name 'has-report' -TargetDate $HasReportDate -ExpectedMode 'report_detail'
$results += Invoke-Scenario -Name 'no-report' -TargetDate $NoReportDate -ExpectedMode 'fallback_news'

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$results | Format-Table name, targetDate, expectedMode, actualMode, itemCount, ok -AutoSize

if ($results.ok -contains $false) {
  exit 1
}
