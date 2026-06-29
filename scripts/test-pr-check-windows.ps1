$ErrorActionPreference = "Stop"

# Used inside Blacksmith Testbox runners to run full CI test suite

Set-Location (git rev-parse --show-toplevel)

function Find-NodeBin {
  param([Parameter(Mandatory = $true)][string]$VersionPrefix)

  $roots = @()
  if ($env:RUNNER_TOOL_CACHE) {
    $roots += $env:RUNNER_TOOL_CACHE
  }
  $roots += @(
    "C:\hostedtoolcache\windows",
    "C:\hostedtoolcache",
    "C:\actions-runner\_work\_tool"
  )

  foreach ($root in $roots) {
    $nodeRoot = Join-Path $root "node"
    if (-not (Test-Path $nodeRoot)) {
      continue
    }

    $match = Get-ChildItem -Path $nodeRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name.StartsWith($VersionPrefix) } |
      Sort-Object Name |
      Select-Object -Last 1

    if ($match) {
      $bin = Join-Path $match.FullName "x64"
      if (Test-Path (Join-Path $bin "node.exe")) {
        return $bin
      }
    }
  }

  return $null
}

function Ensure-Pnpm {
  $pnpmVersion = if ($env:PNPM_VERSION) { $env:PNPM_VERSION } else { "10.33.2" }
  $npmPrefix = Join-Path $env:USERPROFILE ".npm-global"
  $env:PATH = "$npmPrefix;$env:PATH"

  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    return
  }

  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    try {
      Invoke-Native corepack prepare "pnpm@$pnpmVersion" --activate
    } catch {
      Write-Warning "corepack could not activate pnpm: $_"
    }
  }

  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    return
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Unable to find pnpm or npm on PATH."
  }

  New-Item -ItemType Directory -Force -Path $npmPrefix | Out-Null
  Invoke-Native npm config set prefix $npmPrefix
  Invoke-Native npm install -g "pnpm@$pnpmVersion"
  $env:PATH = "$npmPrefix;$env:PATH"

  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "Unable to install pnpm."
  }
}

function Start-Section {
  param([Parameter(Mandatory = $true)][string]$Title)

  Write-Host ""
  Write-Host "::group::$Title"
}

function Stop-Section {
  Write-Host "::endgroup::"
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function Invoke-Section {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock
  )

  Start-Section $Title
  try {
    & $ScriptBlock
  } finally {
    Stop-Section
  }
}

if (-not $env:CI) {
  $env:CI = "true"
}

$node20Bin = Find-NodeBin "20.20"
if ($node20Bin) {
  $env:PATH = "$node20Bin;$env:PATH"
}

Ensure-Pnpm
Invoke-Native pnpm --version

Invoke-Section "Install CLI dependencies" {
  Invoke-Native pnpm install --frozen-lockfile --filter trigger.dev...
}

Invoke-Section "Generate Prisma client" {
  Invoke-Native pnpm run generate
}

Invoke-Section "Build CLI monorepo dependencies" {
  Invoke-Native pnpm run build --filter trigger.dev^...
}

Invoke-Section "Build worker template files" {
  Invoke-Native pnpm --filter trigger.dev run --if-present build:workers
}

Invoke-Section "Enable corepack" {
  Invoke-Native corepack enable
}

Invoke-Section "CLI v3 E2E tests (npm)" {
  $env:LOG = "debug"
  $env:PM = "npm"
  Invoke-Native pnpm --filter trigger.dev run test:e2e
}

Invoke-Section "CLI v3 E2E tests (pnpm)" {
  $env:LOG = "debug"
  $env:PM = "pnpm"
  Invoke-Native pnpm --filter trigger.dev run test:e2e
}

Write-Host "Windows PR checks completed."
