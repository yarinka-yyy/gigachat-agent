$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src\assets'))
$sourcePath = Join-Path $assetDirectory 'gigachat-logo.png'
$iconPath = Join-Path $assetDirectory 'gigachat-icon.ico'
$sizes = @(16, 24, 32, 48, 64, 128, 256)

$source = [System.Drawing.Bitmap]::new($sourcePath)
$cutout = [System.Drawing.Bitmap]::new(320, 320, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  # Copy the source pixels unchanged inside the original disc; discard only the halo.
  for ($y = 0; $y -lt 320; $y++) {
    for ($x = 0; $x -lt 320; $x++) {
      $dx = $x - 159.5
      $dy = $y - 159.5
      if ($dx * $dx + $dy * $dy -le 150.25 * 150.25) {
        $cutout.SetPixel($x, $y, $source.GetPixel($x + 80, $y + 44))
      }
    }
  }

  if ($cutout.GetPixel(0, 0).A -ne 0 -or $cutout.GetPixel(0, 160).A -ne 0 -or
      $cutout.GetPixel(160, 160).A -eq 0) {
    throw 'The icon cutout is not transparent outside the logo.'
  }

  $frames = [System.Collections.Generic.List[byte[]]]::new()
  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $png = [System.IO.MemoryStream]::new()
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($cutout, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
      $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
      $frames.Add($png.ToArray())
    } finally {
      $png.Dispose()
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }

  $file = [System.IO.File]::Create($iconPath)
  $writer = [System.IO.BinaryWriter]::new($file)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$frames[$index].Length)
      $writer.Write([uint32]$offset)
      $offset += $frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write($frame) }
  } finally {
    $writer.Dispose()
  }
} finally {
  $cutout.Dispose()
  $source.Dispose()
}

Write-Output "Built $iconPath"
