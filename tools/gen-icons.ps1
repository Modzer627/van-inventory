# Generates the PWA icon set with System.Drawing (no external tools needed).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools\gen-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root "icons"
if (-not (Test-Path $iconDir)) { New-Item -ItemType Directory -Path $iconDir | Out-Null }

function New-Icon([int]$size, [string]$name, [double]$pad) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $bg = [System.Drawing.ColorTranslator]::FromHtml("#12100D")
    $shelf = [System.Drawing.ColorTranslator]::FromHtml("#F5EFE6")
    $accent = [System.Drawing.ColorTranslator]::FromHtml("#F59E0B")
    $g.Clear($bg)

    # Three shelves (horizontal bars) with a box sitting on the middle one,
    # and an amber scan line across the whole icon.
    $inner = $size * (1.0 - 2.0 * $pad)
    $x0 = $size * $pad
    $y0 = $size * $pad
    $shelfH = [Math]::Max(3, $inner * 0.09)
    $gap = ($inner - 3 * $shelfH) / 2
    $brush = New-Object System.Drawing.SolidBrush($shelf)
    for ($i = 0; $i -lt 3; $i++) {
        $y = $y0 + $i * ($shelfH + $gap)
        $g.FillRectangle($brush, [single]$x0, [single]$y, [single]$inner, [single]$shelfH)
    }
    # Box on the middle shelf
    $boxW = $inner * 0.34
    $boxH = $gap * 0.72
    $bx = $x0 + ($inner - $boxW) * 0.62
    $by = $y0 + $shelfH + $gap - $boxH
    $g.FillRectangle($brush, [single]$bx, [single]$by, [single]$boxW, [single]$boxH)
    # Small box on the top shelf
    $sbW = $inner * 0.22
    $sbH = $gap * 0.5
    $g.FillRectangle($brush, [single]($x0 + $inner * 0.08), [single]($y0 + $shelfH + $gap * 2 + $shelfH - $sbH + $gap - $gap), [single]$sbW, [single]$sbH)

    # Accent scan line across the middle
    $accBrush = New-Object System.Drawing.SolidBrush($accent)
    $lineH = [Math]::Max(3, $size * 0.045)
    $g.FillRectangle($accBrush, [single]($size * ($pad * 0.5)), [single](($size - $lineH) / 2), [single]($size * (1 - $pad)), [single]$lineH)

    $out = Join-Path $iconDir $name
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "wrote $out"
}

New-Icon 512 "icon-512.png" 0.16
New-Icon 192 "icon-192.png" 0.16
New-Icon 512 "icon-maskable-512.png" 0.26
New-Icon 180 "apple-touch-icon.png" 0.16
