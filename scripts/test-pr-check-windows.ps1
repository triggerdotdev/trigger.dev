$ErrorActionPreference = "Stop"

Set-Location (git rev-parse --show-toplevel)

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
