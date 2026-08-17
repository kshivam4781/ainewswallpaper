<#
    Renders the AI news wallpaper with System.Drawing and applies it via
    SystemParametersInfo. Input is a JSON file written by the Node CLI:

    {
      "outputPath": "...png",
      "width": 1920, "height": 1080,   // optional, auto-detected when absent
      "align": "right",
      "heading": "AI NEWS",
      "subheading": "Monday, 17 August 2026",
      "footer": "Updated 14:32",
      "setWallpaper": true,
      "theme": { "bgTop": "#0A0E1A", ... },
      "items":  [ { "title": "...", "source": "...", "meta": "..." } ],
      "panels": [ { "heading": "TODAY", "subheading": "...",
                    "entries": [ { "tag", "tagStyle", "title", "description", "meta" } ] } ]
    }

    Keep this file pure ASCII: PowerShell 5.1 reads BOM-less .ps1 as ANSI and
    would mangle any non-ASCII literal. All display text arrives via JSON.
#>
param(
    [Parameter(Mandatory = $true)][string]$DataPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ([System.Management.Automation.PSTypeName]'AiNewsWallpaperNative').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AiNewsWallpaperNative {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
'@
}

$data = [System.IO.File]::ReadAllText($DataPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$theme = $data.theme

function Get-Color {
    param([string]$Hex, [int]$Alpha = 255)
    $c = [System.Drawing.ColorTranslator]::FromHtml($Hex)
    return [System.Drawing.Color]::FromArgb($Alpha, $c.R, $c.G, $c.B)
}

function New-Font {
    param([string]$Family, [double]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
    $size = [Math]::Max(8.0, $Size)
    try {
        return New-Object System.Drawing.Font($Family, [single]$size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
    } catch {
        return New-Object System.Drawing.Font('Segoe UI', [single]$size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
    }
}

# --- Canvas size -------------------------------------------------------------
[void][AiNewsWallpaperNative]::SetProcessDPIAware()
$W = 0; $H = 0
if ($data.width) { $W = [int]$data.width }
if ($data.height) { $H = [int]$data.height }
if ($W -le 0 -or $H -le 0) {
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $W = $bounds.Width
        $H = $bounds.Height
    } catch { }
}
if ($W -le 0 -or $H -le 0) { $W = 1920; $H = 1080 }

$bitmap = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$fmt = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces

function Measure-Text {
    param([string]$Text, [System.Drawing.Font]$Font)
    if ([string]::IsNullOrEmpty($Text)) { return 0.0 }
    return [double]$g.MeasureString($Text, $Font, [System.Drawing.PointF]::new(0, 0), $fmt).Width
}

function Get-WrappedLines {
    param([string]$Text, [System.Drawing.Font]$Font, [double]$MaxWidth, [int]$MaxLines = 3)
    if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
    $words = ($Text -split '\s+') | Where-Object { $_ -ne '' }
    $lines = New-Object System.Collections.ArrayList
    $current = ''
    foreach ($word in $words) {
        $candidate = if ($current -eq '') { $word } else { "$current $word" }
        if ((Measure-Text $candidate $Font) -le $MaxWidth -or $current -eq '') {
            $current = $candidate
        } else {
            [void]$lines.Add($current)
            $current = $word
            if ($lines.Count -ge $MaxLines) { break }
        }
    }
    if ($lines.Count -lt $MaxLines -and $current -ne '') { [void]$lines.Add($current) }

    if ($lines.Count -ge $MaxLines) {
        # Anything left over gets folded into an ellipsis on the final line.
        $consumed = ($lines -join ' ')
        if ($consumed.Length -lt $Text.Length - 1) {
            $last = $lines[$lines.Count - 1]
            while ($last.Length -gt 4 -and (Measure-Text ($last + '...') $Font) -gt $MaxWidth) {
                $last = $last.Substring(0, $last.Length - 1).TrimEnd()
            }
            $lines[$lines.Count - 1] = $last + '...'
        }
    }
    return @($lines)
}

# --- Background --------------------------------------------------------------
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect, (Get-Color $theme.bgTop), (Get-Color $theme.bgBottom), 55.0)
$g.FillRectangle($bg, $rect)
$bg.Dispose()

$dotBrush = New-Object System.Drawing.SolidBrush((Get-Color $theme.dot 150))
$step = [int][Math]::Max(28, [Math]::Round($W / 52))
for ($x = $step; $x -lt $W; $x += $step) {
    for ($y = $step; $y -lt $H; $y += $step) {
        $g.FillEllipse($dotBrush, $x, $y, 2, 2)
    }
}
$dotBrush.Dispose()

# --- Layout metrics ----------------------------------------------------------
$panels = @()
if ($data.panels) { $panels = @($data.panels) }
$hasTools = $panels.Count -gt 0

# On a wide screen every panel earns its own column; otherwise they stack down
# one side, which fits far fewer entries.
$columnsMode = $hasTools -and $panels.Count -ge 2 -and $W -ge 2000 -and (($W / $H) -ge 1.45)

$panelX = @()
$panelW = @()

if ($columnsMode) {
    $margin = [int][Math]::Round($W * 0.045)
    $available = $W - 2 * $margin
    $gap = [int][Math]::Round($available * 0.035)
    $colW = [int][Math]::Round($available * 0.40)
    $each = [int](($available - $colW - $gap * $panels.Count) / $panels.Count)

    if ($data.align -eq 'left') {
        $colX = $margin
        $cursor = $margin + $colW + $gap
    } else {
        $colX = $W - $margin - $colW
        $cursor = $margin
    }
    for ($p = 0; $p -lt $panels.Count; $p++) {
        $panelX += $cursor
        $panelW += $each
        $cursor += $each + $gap
    }
} elseif ($hasTools) {
    $margin = [int][Math]::Round($W * 0.055)
    $available = $W - 2 * $margin
    $colW = [int][Math]::Min([Math]::Round($available * 0.58), 1500)
    $each = [int][Math]::Round($available * 0.32)
    if ($data.align -eq 'left') {
        $colX = $margin
        $sideX = $W - $margin - $each
    } else {
        $colX = $W - $margin - $colW
        $sideX = $margin
    }
    for ($p = 0; $p -lt $panels.Count; $p++) {
        $panelX += $sideX
        $panelW += $each
    }
} else {
    $margin = [int][Math]::Round($W * 0.055)
    $available = $W - 2 * $margin
    $colW = [int][Math]::Min([Math]::Round($W * 0.46), 1000)
    $colW = [int][Math]::Max($colW, [Math]::Min(520, $available))
    switch ($data.align) {
        'left'   { $colX = $margin }
        'center' { $colX = [int](($W - $colW) / 2) }
        default  { $colX = $W - $margin - $colW }
    }
}

# Glow behind the headline column
$glowR = [int]($colW * 0.95)
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(($colX + $colW / 2 - $glowR), ($H / 2 - $glowR), ($glowR * 2), ($glowR * 2))
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glowBrush.CenterColor = (Get-Color $theme.glow 120)
$glowBrush.SurroundColors = @((Get-Color $theme.glow 0))
$g.FillPath($glowBrush, $glowPath)
$glowBrush.Dispose()
$glowPath.Dispose()

# --- Measure the headline column ---------------------------------------------
$items = @($data.items)
$scale = 1.0

# The quote band owns a strip along the bottom, so the columns get what is left.
$hasQuote = $data.quote -and $data.quote.text
$quoteBand = if ($hasQuote) { $H * 0.135 } else { 0.0 }
$maxHeight = $H - (2 * [int]($H * 0.09)) - $quoteBand

for ($attempt = 0; $attempt -lt 14; $attempt++) {
    $fTitle     = New-Font 'Segoe UI' ([Math]::Round($H * 0.052 * $scale)) ([System.Drawing.FontStyle]::Bold)
    $fSub       = New-Font 'Segoe UI' ([Math]::Round($H * 0.0175 * $scale))
    $fHeadline  = New-Font 'Segoe UI Semibold' ([Math]::Round($H * 0.0235 * $scale)) ([System.Drawing.FontStyle]::Bold)
    $fMeta      = New-Font 'Segoe UI' ([Math]::Round($H * 0.0142 * $scale))
    $fIndex     = New-Font 'Consolas' ([Math]::Round($H * 0.0155 * $scale)) ([System.Drawing.FontStyle]::Bold)
    $fFooter    = New-Font 'Segoe UI' ([Math]::Round($H * 0.0132 * $scale))

    $indexW    = [double][Math]::Max((Measure-Text '00' $fIndex) + $H * 0.016, $H * 0.030)
    $textW     = $colW - $indexW
    $lineGap   = $fHeadline.Height * 0.16
    $itemGap   = $fHeadline.Height * 0.85

    $layout = New-Object System.Collections.ArrayList
    $total = 0.0
    $total += $H * 0.010
    $total += $fTitle.Height
    $total += $H * 0.006
    $total += $fSub.Height
    $total += $H * 0.030
    foreach ($item in $items) {
        $lines = Get-WrappedLines $item.title $fHeadline $textW 3
        $blockH = ($lines.Count * $fHeadline.Height) + (([Math]::Max(0, $lines.Count - 1)) * $lineGap) + ($fHeadline.Height * 0.22) + $fMeta.Height
        [void]$layout.Add([pscustomobject]@{ Lines = $lines; Height = $blockH; Item = $item })
        $total += $blockH + $itemGap
    }
    $total -= $itemGap
    $total += $H * 0.035 + $fFooter.Height

    if ($total -le $maxHeight) { break }

    if ($scale -gt 0.78) {
        $scale = $scale * 0.94
    } elseif ($items.Count -gt 3) {
        $items = $items[0..($items.Count - 2)]
    } else {
        break
    }
}

# --- Measure the panels ------------------------------------------------------
$toolsTotal = 0.0
$toolsLayout = New-Object System.Collections.ArrayList
$toolsScale = 1.0
$budgets = @()

if ($hasTools) {
    foreach ($panel in $panels) { $budgets += @($panel.entries).Count }

    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $fPanelTitle = New-Font 'Segoe UI' ([Math]::Round($H * 0.0300 * $toolsScale)) ([System.Drawing.FontStyle]::Bold)
        $fPanelSub   = New-Font 'Segoe UI' ([Math]::Round($H * 0.0132 * $toolsScale))
        $fTag        = New-Font 'Segoe UI' ([Math]::Round($H * 0.0102 * $toolsScale)) ([System.Drawing.FontStyle]::Bold)
        $fEntryName  = New-Font 'Segoe UI Semibold' ([Math]::Round($H * 0.0180 * $toolsScale)) ([System.Drawing.FontStyle]::Bold)
        $fEntryDesc  = New-Font 'Segoe UI' ([Math]::Round($H * 0.0130 * $toolsScale))
        $fEntryMeta  = New-Font 'Segoe UI' ([Math]::Round($H * 0.0118 * $toolsScale))

        $descGap  = $fEntryDesc.Height * 0.14
        $entryGap = $H * 0.024 * $toolsScale
        $panelGap = $H * 0.034 * $toolsScale
        $headH    = ($H * 0.010) + ($H * 0.006) + $fPanelTitle.Height + ($H * 0.005) `
                  + $fPanelSub.Height + ($H * 0.018) + ($H * 0.012)

        $toolsLayout.Clear()
        $heights = @()

        for ($p = 0; $p -lt $panels.Count; $p++) {
            if ($budgets[$p] -le 0) { $heights += 0.0; continue }
            $entries = @($panels[$p].entries)
            if ($budgets[$p] -lt $entries.Count) { $entries = $entries[0..($budgets[$p] - 1)] }

            $blocks = New-Object System.Collections.ArrayList
            $height = $headH
            foreach ($entry in $entries) {
                $descLines = Get-WrappedLines $entry.description $fEntryDesc $panelW[$p] 2
                $blockH = $fTag.Height + ($H * 0.003) + $fEntryName.Height + ($H * 0.004)
                if ($descLines.Count -gt 0) {
                    $blockH += ($descLines.Count * $fEntryDesc.Height) + (($descLines.Count - 1) * $descGap) + ($H * 0.004)
                }
                $blockH += $fEntryMeta.Height
                [void]$blocks.Add([pscustomobject]@{ Entry = $entry; Desc = $descLines; Height = $blockH })
                $height += $blockH + $entryGap
            }
            if ($blocks.Count -gt 0) { $height -= $entryGap }
            $heights += $height
            [void]$toolsLayout.Add([pscustomobject]@{
                Panel = $panels[$p]; Blocks = $blocks; X = $panelX[$p]; Width = $panelW[$p]; Height = $height; Index = $p
            })
        }

        if ($columnsMode) {
            # Independent columns: the tallest one decides whether we fit.
            $toolsTotal = ($heights | Measure-Object -Maximum).Maximum
        } else {
            $visible = @($toolsLayout).Count
            $toolsTotal = 0.0
            # NB: not $h - PowerShell variables are case-insensitive and that
            # would clobber $H, the canvas height.
            foreach ($panelHeight in $heights) { $toolsTotal += $panelHeight }
            if ($visible -gt 1) { $toolsTotal += $panelGap * ($visible - 1) }
        }

        if ($toolsTotal -le $maxHeight) { break }

        if ($toolsScale -gt 0.74) {
            $toolsScale = $toolsScale * 0.95
        } else {
            $trimmed = $false
            if ($columnsMode) {
                # Trim only the column that actually overflows.
                $worst = -1; $worstH = 0.0
                for ($p = 0; $p -lt $heights.Count; $p++) {
                    if ($heights[$p] -gt $worstH -and $budgets[$p] -gt 2) { $worstH = $heights[$p]; $worst = $p }
                }
                if ($worst -ge 0) { $budgets[$worst] = $budgets[$worst] - 1; $trimmed = $true }
            } else {
                for ($p = $panels.Count - 1; $p -ge 0; $p--) {
                    if ($budgets[$p] -gt 2) { $budgets[$p] = $budgets[$p] - 1; $trimmed = $true; break }
                }
            }
            if (-not $trimmed) { break }
        }
    }
}

# --- Draw --------------------------------------------------------------------
$brTitle  = New-Object System.Drawing.SolidBrush((Get-Color $theme.title))
$brBody   = New-Object System.Drawing.SolidBrush((Get-Color $theme.body))
$brMuted  = New-Object System.Drawing.SolidBrush((Get-Color $theme.muted))
$brAccent = New-Object System.Drawing.SolidBrush((Get-Color $theme.accent))
$brSoft   = New-Object System.Drawing.SolidBrush((Get-Color $theme.accentSoft))
$penRule  = New-Object System.Drawing.Pen((Get-Color $theme.rule), 1.0)

# Every column starts on the same line, and the tallest one decides the top.
# Centre within the area above the quote band, not the whole screen.
$top = [double](($H - $quoteBand - [Math]::Max($total, $toolsTotal)) / 2)
if ($top -lt $H * 0.06) { $top = $H * 0.06 }
$y = $top

$g.FillRectangle($brAccent, [single]$colX, [single]$y, [single]($H * 0.075), [single][Math]::Max(3, $H * 0.0045))
$y += $H * 0.010 + $H * 0.006

$g.DrawString($data.heading, $fTitle, $brTitle, [single]$colX, [single]$y, $fmt)
$y += $fTitle.Height + $H * 0.006
$g.DrawString($data.subheading, $fSub, $brMuted, [single]$colX, [single]$y, $fmt)
$y += $fSub.Height + $H * 0.018

$g.DrawLine($penRule, [single]$colX, [single]$y, [single]($colX + $colW), [single]$y)
$y += $H * 0.012

$n = 0
foreach ($entry in $layout) {
    $n++
    $g.DrawString(('{0:00}' -f $n), $fIndex, $brSoft, [single]$colX, [single]($y + $fHeadline.Height * 0.22), $fmt)

    $lineY = $y
    foreach ($line in $entry.Lines) {
        $g.DrawString($line, $fHeadline, $brBody, [single]($colX + $indexW), [single]$lineY, $fmt)
        $lineY += $fHeadline.Height + $lineGap
    }

    $metaY = $lineY - $lineGap + ($fHeadline.Height * 0.22)
    # Meta text is composed in Node so this file can stay ASCII-only.
    $g.DrawString($entry.Item.meta, $fMeta, $brMuted, [single]($colX + $indexW), [single]$metaY, $fmt)

    $y += $entry.Height + $itemGap
}

$y = $y - $itemGap + $H * 0.030
$g.DrawLine($penRule, [single]$colX, [single]$y, [single]($colX + $colW), [single]$y)
$y += $H * 0.012
$g.DrawString(($data.footer -f $layout.Count), $fFooter, $brMuted, [single]$colX, [single]$y, $fmt)

# --- Draw the panels ---------------------------------------------------------
if ($hasTools) {
    $stackY = $top

    foreach ($section in $toolsLayout) {
        $px = $section.X
        $pw = $section.Width
        # Columns start level; stacked panels flow on from the previous one.
        $ty = if ($columnsMode) { $top } else { $stackY }

        $g.FillRectangle($brAccent, [single]$px, [single]$ty, [single]($H * 0.055), [single][Math]::Max(3, $H * 0.0045))
        $ty += $H * 0.010 + $H * 0.006

        $g.DrawString($section.Panel.heading, $fPanelTitle, $brTitle, [single]$px, [single]$ty, $fmt)
        $ty += $fPanelTitle.Height + $H * 0.005
        $g.DrawString($section.Panel.subheading, $fPanelSub, $brMuted, [single]$px, [single]$ty, $fmt)
        $ty += $fPanelSub.Height + $H * 0.018

        $g.DrawLine($penRule, [single]$px, [single]$ty, [single]($px + $pw), [single]$ty)
        $ty += $H * 0.012

        foreach ($block in $section.Blocks) {
            # Accent-tagged entries (important mail, upcoming events, "FOR YOU"
            # repos) stand out from the routine ones.
            $tagBrush = if ($block.Entry.tagStyle -eq 'accent') { $brAccent } else { $brMuted }
            $g.DrawString($block.Entry.tag, $fTag, $tagBrush, [single]$px, [single]$ty, $fmt)
            $ty += $fTag.Height + $H * 0.003

            $g.DrawString($block.Entry.title, $fEntryName, $brTitle, [single]$px, [single]$ty, $fmt)
            $ty += $fEntryName.Height + $H * 0.004

            if ($block.Desc.Count -gt 0) {
                foreach ($line in $block.Desc) {
                    $g.DrawString($line, $fEntryDesc, $brBody, [single]$px, [single]$ty, $fmt)
                    $ty += $fEntryDesc.Height + $descGap
                }
                $ty = $ty - $descGap + $H * 0.004
            }

            $g.DrawString($block.Entry.meta, $fEntryMeta, $brSoft, [single]$px, [single]$ty, $fmt)
            $ty += $fEntryMeta.Height + $entryGap
        }

        if (-not $columnsMode) { $stackY = $ty - $entryGap + $panelGap }
    }
}

# --- Draw the quote band -----------------------------------------------------
if ($hasQuote) {
    # Span from the leftmost column to the right edge of the headline column.
    $bandLeft = $colX
    $bandRight = $colX + $colW
    foreach ($px in $panelX) {
        if ($px -lt $bandLeft) { $bandLeft = $px }
    }
    for ($p = 0; $p -lt $panelX.Count; $p++) {
        $right = $panelX[$p] + $panelW[$p]
        if ($right -gt $bandRight) { $bandRight = $right }
    }
    $bandW = $bandRight - $bandLeft

    $quoteScale = 1.0
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $fQuote  = New-Font 'Segoe UI Light' ([Math]::Round($H * 0.0295 * $quoteScale))
        $fAuthor = New-Font 'Segoe UI' ([Math]::Round($H * 0.0150 * $quoteScale)) ([System.Drawing.FontStyle]::Bold)
        $quoteLines = Get-WrappedLines $data.quote.text $fQuote $bandW 2
        $needed = ($quoteLines.Count * $fQuote.Height) + ($H * 0.010) + $fAuthor.Height
        if ($needed -le $quoteBand -or $quoteScale -le 0.7) { break }
        $quoteScale = $quoteScale * 0.93
    }

    $qy = $H - $quoteBand + ($H * 0.012)

    $g.DrawLine($penRule, [single]$bandLeft, [single]($qy - $H * 0.022), [single]$bandRight, [single]($qy - $H * 0.022))

    # A thick accent stub reads as an opening quote mark without needing a glyph.
    $g.FillRectangle($brAccent, [single]$bandLeft, [single]$qy, [single][Math]::Max(3, $H * 0.0035), [single]($quoteLines.Count * $fQuote.Height))

    $textX = $bandLeft + ($H * 0.020)
    $ly = $qy
    foreach ($line in $quoteLines) {
        $g.DrawString($line, $fQuote, $brTitle, [single]$textX, [single]$ly, $fmt)
        $ly += $fQuote.Height
    }

    if ($data.quote.author) {
        $ly += $H * 0.008
        $g.DrawString($data.quote.author, $fAuthor, $brSoft, [single]$textX, [single]$ly, $fmt)
    }
}

$g.Dispose()

# --- Save --------------------------------------------------------------------
$outPath = $data.outputPath
$dir = Split-Path -Parent $outPath
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

# --- Apply -------------------------------------------------------------------
if ($data.setWallpaper) {
    $deskKey = 'HKCU:\Control Panel\Desktop'
    Set-ItemProperty -Path $deskKey -Name WallpaperStyle -Value '10'   # 10 = Fill
    Set-ItemProperty -Path $deskKey -Name TileWallpaper -Value '0'
    $SPI_SETDESKWALLPAPER = 20
    $UPDATE_AND_BROADCAST = 0x01 -bor 0x02
    $result = [AiNewsWallpaperNative]::SystemParametersInfo($SPI_SETDESKWALLPAPER, 0, $outPath, $UPDATE_AND_BROADCAST)
    if ($result -eq 0) { throw "SystemParametersInfo failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
}

if ($env:AINW_DEBUG) {
    Write-Output ("DEBUG|mode={0}|newsTotal={1}|toolsTotal={2}|maxHeight={3}|newsScale={4}|toolsScale={5}|budgets={6}" -f `
        $(if ($columnsMode) { 'columns' } else { 'stacked' }), ([int]$total), ([int]$toolsTotal), ([int]$maxHeight), $scale, $toolsScale, ($budgets -join ','))
}

Write-Output ("RENDER_OK|{0}|{1}|{2}|{3}" -f $outPath, $W, $H, $layout.Count)
