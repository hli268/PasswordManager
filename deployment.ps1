param(
  [string]$Output = "vault.html",
  [string]$SourceDir = "."
)

function Fail($msg) { Write-Error $msg; exit 1 }

$indexPath  = Join-Path $SourceDir 'index.html'
$cssPath    = Join-Path $SourceDir 'styles.css'
$cryptoPath = Join-Path $SourceDir 'crypto.js'
$vaultPath  = Join-Path $SourceDir 'vault.js'
$storagePath= Join-Path $SourceDir 'storage.js'
$uiPath     = Join-Path $SourceDir 'ui.js'
$appPath    = Join-Path $SourceDir 'app.js'

# Validate required files. crypto.js is REQUIRED: app.js calls
# VaultCrypto.isAvailable() as the very first thing it does at load time, so
# a build without crypto.js inlined would ship a vault.html that throws
# "VaultCrypto is not defined" immediately on open. It used to be treated as
# optional here, which was inconsistent with that hard runtime dependency.
foreach ($p in @($indexPath, $cssPath, $cryptoPath, $vaultPath, $storagePath, $uiPath, $appPath)) {
  if (-not (Test-Path $p)) { Fail "Required file not found: $p" }
}

# Read files as raw UTF8
$index   = Get-Content -Raw -Encoding UTF8 $indexPath
$css     = Get-Content -Raw -Encoding UTF8 $cssPath
$crypto  = Get-Content -Raw -Encoding UTF8 $cryptoPath
$vault   = Get-Content -Raw -Encoding UTF8 $vaultPath
$storage = Get-Content -Raw -Encoding UTF8 $storagePath
$ui      = Get-Content -Raw -Encoding UTF8 $uiPath
$app     = Get-Content -Raw -Encoding UTF8 $appPath

# Inline stylesheet: replace link to styles.css with <style>...</style>
$index = [System.Text.RegularExpressions.Regex]::Replace(
  $index,
  '(?is)<link\b[^>]*\bhref\s*=\s*["'']\s*styles\.css\s*["''][^>]*>',
  "<style>`r`n$css`r`n</style>"
)

# Inline crypto.js on its own (it's loaded via its own <script src> tag,
# ahead of vault/storage/ui/app).
$index = [System.Text.RegularExpressions.Regex]::Replace(
  $index,
  '(?is)<script\b[^>]*\bsrc\s*=\s*["'']\s*crypto\.js\s*["''][^>]*>\s*</script>',
  "<script>`r`n$crypto`r`n</script>"
)

# Replace the app script tag with the combined inlined scripts (vault -> storage -> ui -> app).
$combinedScripts = "<script>`r`n$vault`r`n</script>`r`n<script>`r`n$storage`r`n</script>`r`n<script>`r`n$ui`r`n</script>`r`n<script>`r`n$app`r`n</script>"
$index = [System.Text.RegularExpressions.Regex]::Replace(
  $index,
  '(?is)<script\b[^>]*\bsrc\s*=\s*["'']\s*app\.js\s*["''][^>]*>\s*</script>',
  $combinedScripts
)

# If there are multiple script tags or the files were referenced with different attributes,
# the regex above handles common variants (case-insensitive, whitespace tolerant).
# Write out combined file as UTF8
Set-Content -Path $Output -Value $index -Encoding UTF8

Write-Host "Single-file build written to: $Output"
