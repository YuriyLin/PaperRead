param([string]$Executable = "", [ValidateRange(0, 65535)][int]$DebugPort = 0,
    [ValidateSet("Mock", "RealModelValidation")][string]$Mode = "Mock",
    [ValidateSet("Mock", "GeminiValidation")][string]$ReviewData = "Mock")
$ErrorActionPreference = "Stop"
if ($Mode -ne "Mock") {
    throw "RealModelValidation is blocked: Codex tool, read-scope and login/provider isolation are not verified. No model was started."
}
$reviewRepo = Split-Path -Parent $PSScriptRoot
$reviewProfile = Join-Path $reviewRepo ".paperread-local-test\desktop-review"
if ($ReviewData -eq "GeminiValidation") {
    $reviewProfile = Join-Path $reviewRepo ".paperread-local-test\gemini-validation"
    & (Join-Path $reviewRepo ".venv\Scripts\python.exe") (Join-Path $reviewRepo "scripts\validate_gemini_table.py") --init
    if ($LASTEXITCODE -ne 0) { throw "Gemini validation result profile was rejected." }
}
# No config, library, Vault, installer, protocol association or API key is copied.
if ($Executable) {
    $reviewApp = (Resolve-Path -LiteralPath $Executable).Path
    $reviewBuild = [IO.Path]::GetFullPath((Join-Path $reviewRepo "dist\table-review")) + [IO.Path]::DirectorySeparatorChar
    if (-not $reviewApp.StartsWith($reviewBuild, [StringComparison]::OrdinalIgnoreCase)) { throw "Only an unpacked test executable under dist/table-review is allowed; do not launch an installed PaperRead." }
    $reviewArgs = @()
} else {
    $reviewApp = Join-Path $reviewRepo "node_modules\electron\dist\electron.exe"
    $reviewArgs = @($reviewRepo)
}
if (-not (Test-Path -LiteralPath $reviewApp -PathType Leaf)) { throw "Electron is missing. Run npm ci, or pass -Executable with the unpacked test executable." }
if ($DebugPort) { $reviewArgs += @("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$DebugPort") }
$reviewOldProfile = $env:PAPERREAD_TEST_PROFILE
$reviewOldMode = $env:PAPERREAD_REVIEW_MODE
$reviewOldKind = $env:PAPERREAD_REVIEW_KIND
$reviewOldNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:PAPERREAD_TEST_PROFILE = $reviewProfile
    $env:PAPERREAD_REVIEW_MODE = $Mode
    $env:PAPERREAD_REVIEW_KIND = if ($ReviewData -eq "GeminiValidation") { "GeminiResults" } else { $null }
    $env:ELECTRON_RUN_AS_NODE = $null
    Write-Host "PaperRead review mode: Mock. Real model calls are forbidden."
    & $reviewApp @reviewArgs
} finally {
    $env:PAPERREAD_TEST_PROFILE = $reviewOldProfile
    $env:PAPERREAD_REVIEW_MODE = $reviewOldMode
    $env:PAPERREAD_REVIEW_KIND = $reviewOldKind
    $env:ELECTRON_RUN_AS_NODE = $reviewOldNode
}
