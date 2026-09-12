param(
  [string]$Output = "vault.html",
  [string]$SourceDir = "."
)

function Fail($msg) { Write-Error $msg; exit 1 }

$indexPath  = Join-Path $SourceDir 'index.html'
$cssPath    = Join-Path $SourceDir 'styles.css'
$cryptoPath = Join-Path $SourceDir 'crypto.js'
$appPath    = Join-Path $SourceDir 'app.js'

# Validate
foreach ($p in @($indexPath, $cssPath, $cryptoPath, $appPath)) {
  if (-not (Test-Path $p)) { Fail "Required file not found: $p" }
}

# Read files as raw UTF8
$index  = Get-Content -Raw -Encoding UTF8 $indexPath
$css    = Get-Content -Raw -Encoding UTF8 $cssPath
$crypto = Get-Content -Raw -Encoding UTF8 $cryptoPath
$app    = Get-Content -Raw -Encoding UTF8 $appPath

# Inline stylesheet: replace link to styles.css with <style>...</style>
$index = [System.Text.RegularExpressions.Regex]::Replace(
  $index,
  '(?is)<link\b[^>]*\bhref\s*=\s*["'']\s*styles\.css\s*["''][^>]*>',
  "<style>`r`n$css`r`n</style>"
)

# Inline crypto.js and app.js. Keep the order: crypto -> app
$index = [System.Text.RegularExpressions.Regex]::Replace(
  $index,
  '(?is)<script\b[^>]*\bsrc\s*=\s*["'']\s*crypto\.js\s*["''][^>]*>\s*</script>',
  "<script>`r`n$crypto`r`n</script>"
)

$index = [System.Text.RegularExpressions.Regex]::Replace(
  $index,
  '(?is)<script\b[^>]*\bsrc\s*=\s*["'']\s*app\.js\s*["''][^>]*>\s*</script>',
  "<script>`r`n$app`r`n</script>"
)

# If there are multiple script tags or the files were referenced with different attributes,
# the regex above handles common variants (case-insensitive, whitespace tolerant).
# Write out combined file as UTF8
Set-Content -Path $Output -Value $index -Encoding UTF8

Write-Host "Single-file build written to: $Output"
