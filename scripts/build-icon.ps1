$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop\assets'
New-Item -ItemType Directory -Path $assetDir -Force | Out-Null
function RoundRect($graphics, $brush, [single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
    $path = [Drawing.Drawing2D.GraphicsPath]::new()
    try {
        $d = $radius * 2
        $path.AddArc($x, $y, $d, $d, 180, 90)
        $path.AddArc($x + $width - $d, $y, $d, $d, 270, 90)
        $path.AddArc($x + $width - $d, $y + $height - $d, $d, $d, 0, 90)
        $path.AddArc($x, $y + $height - $d, $d, $d, 90, 90)
        $path.CloseFigure(); $graphics.FillPath($brush, $path)
    } finally { $path.Dispose() }
}
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($size in $sizes) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $green = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#245c46'))
    $cream = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#f5f6e9'))
    $gold = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#dfc479'))
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.ScaleTransform($size / 256.0, $size / 256.0)
        RoundRect $graphics $green 12 12 232 232 54
        foreach ($bar in @(@(52,106,44), @(86,76,104), @(120,52,152), @(154,90,76), @(188,113,30))) {
            RoundRect $graphics $cream $bar[0] $bar[1] 16 $bar[2] 8
        }
        $points = [Drawing.PointF[]]@([Drawing.PointF]::new(194,40), [Drawing.PointF]::new(199,54), [Drawing.PointF]::new(213,59), [Drawing.PointF]::new(199,64), [Drawing.PointF]::new(194,78), [Drawing.PointF]::new(189,64), [Drawing.PointF]::new(175,59), [Drawing.PointF]::new(189,54))
        $graphics.FillPolygon($gold, $points)
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $frames += ,$stream.ToArray()
        if ($size -eq 256) { $bitmap.Save((Join-Path $assetDir 'summer-music.png'), [Drawing.Imaging.ImageFormat]::Png) }
    } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $green.Dispose(); $cream.Dispose(); $gold.Dispose() }
}
$file = [IO.File]::Create((Join-Path $assetDir 'summer-music.ico'))
$writer = [IO.BinaryWriter]::new($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
} finally { $writer.Dispose(); $file.Dispose() }
Write-Output 'Built seven-size Windows icon (16-256 px).'
