
# make-assets.ps1 : regenere les assets de l'installateur a partir de
# model-manager\public\logo.svg (geometrie et palette reprises a l'identique).
#
# CONTRAINTE IMPORTANTE : les .bmp doivent etre en 24bpp. Inno Setup ignore le
# canal alpha ; un 32bpp produit un fond noir dans l'assistant.
param(
    [string]$Svg = (Join-Path $PSScriptRoot '..\model-manager\public\logo.svg'),
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# --- Palette (logo.svg) ---------------------------------------------------
$Indigo = [System.Drawing.Color]::FromArgb(0x4F, 0x46, 0xE5)   # #4F46E5
$Purple = [System.Drawing.Color]::FromArgb(0x93, 0x33, 0xEA)  # #9333EA
$Ink    = [System.Drawing.Color]::FromArgb(0x0F, 0x17, 0x2A)  # rgba(15,23,42)

function New-LogoBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 500.0   # viewBox 0 0 500 500
    $d = [single]$s

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point([int](500 * $s), [int](500 * $s))),
        $Indigo, $Purple)

    # ── Anneaux (ellipses, plus des cercles depuis la revision du SVG) ──────
    # Exterieur : cx=244.5 cy=254 rx=198.5 ry=166
    $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, $Ink.R, $Ink.G, $Ink.B))),
        [single](46.0 * $s), [single](88.0 * $s), [single](397.0 * $s), [single](332.0 * $s))
    $g.DrawEllipse((New-Object System.Drawing.Pen($brush, [single](10 * $s))),
        [single](46.0 * $s), [single](88.0 * $s), [single](397.0 * $s), [single](332.0 * $s))

    # Seconde ellipse, croisee avec la precedente. Dans le SVG elle porte
    # transform="matrix(0,-1,1,0,20.5,528.5)" sur cx=271.5 cy=224 rx=198.5
    # ry=166. Cette matrice est une rotation de 90 deg, donc rx et ry
    # s'inversent : centre effectif (244.5, 257), rayon horizontal 166,
    # rayon vertical 198.5. Volontaire dans la maquette.
    $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, $Ink.R, $Ink.G, $Ink.B))),
        [single](78.5 * $s), [single](58.5 * $s), [single](332.0 * $s), [single](397.0 * $s))
    $g.DrawEllipse((New-Object System.Drawing.Pen($brush, [single](10 * $s))),
        [single](78.5 * $s), [single](58.5 * $s), [single](332.0 * $s), [single](397.0 * $s))

    # Interieur : cx=244 cy=254.5 rx=139 ry=154.5
    $g.DrawEllipse((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(31, 255, 255, 255), [single](6 * $s))),
        [single](105.0 * $s), [single](100.0 * $s), [single](278.0 * $s), [single](309.0 * $s))

    # ── Hexagone ───────────────────────────────────────────────────────────
    # Sommets exprimes comme dans le SVG, avec sa transformation
    # matrix(0.9,0,0,1,0.7,0) appliquee puis translate(250,250) :
    #   x' = 0.9 * x + 0.7 + 250
    #   y' = y + 250
    # Le facteur 0.9 ecrase legerement l'hexagone en largeur.
    $rawPts = @(@(-6.5, -137.0), @(113.5, -67.0), @(113.5, 73.0), @(-6.5, 143.0), @(-126.5, 73.0), @(-126.5, -67.0))
    $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    foreach ($p in $rawPts) {
        $x = (0.9 * $p[0]) + 0.7 + 250.0
        $y = $p[1] + 250.0
        $pts.Add((New-Object System.Drawing.PointF([single]($x * $s), [single]($y * $s))))
    }
    # Contour : 20 unites (le SVG en met 18, legerement beefi pour rester net
    # sur fond clair et a petite echelle).
    $g.DrawPolygon((New-Object System.Drawing.Pen($brush, [single](20 * $s))), $pts.ToArray())

    # ── Fuseaux ────────────────────────────────────────────────────────────
    # Noyau du SVG : (-6.5, 3) applique a la meme transformation, soit
    # (244.85, 253). Les fuseaux vont du sommet vers ce noyau, raccourcis a
    # 82% : les faire partir exactement du vertex les fait chevaucher le
    # contour, et l'icone se lit alors comme une etoile.
    $coreX = (0.9 * -6.5) + 0.7 + 250.0
    $coreY = 3.0 + 250.0
    $nodePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single](9 * $s))
    $nodePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $nodePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    foreach ($p in $rawPts) {
        $vx = (0.9 * $p[0]) + 0.7 + 250.0
        $vy = $p[1] + 250.0
        $ex = $vx + 0.82 * ($coreX - $vx)
        $ey = $vy + 0.82 * ($coreY - $vy)
        $g.DrawLine($nodePen, [single]($vx * $s), [single]($vy * $s), [single]($ex * $s), [single]($ey * $s))
    }

    # ── Noyau blanc (r=30) ────────────────────────────────────────────────
    $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242, 255, 255, 255))),
        [single](($coreX - 30) * $s), [single](($coreY - 30) * $s), [single](60 * $s), [single](60 * $s))

    # ── Les 6 points blancs du pourtour (positions du SVG revise) ─────────
    foreach ($p in @(@(245,110), @(349,187), @(345,318), @(246,388), @(140,326), @(140,188))) {
        $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)),
            [single](($p[0] - 14) * $s), [single](($p[1] - 14) * $s), [single](28 * $s), [single](28 * $s))
    }

    $g.Dispose(); $brush.Dispose()
    return $bmp
}

# --- ICO multi-tailles -----------------------------------------------------
# Un ICO doit contenir plusieurs resolutions : Windows choisit la meilleure
# selon le contexte (16 Explorateur, 32 barre des taches, 256 vignette).
# L'entree est ecrite a la main car Icon.FromBitmap().Save() ne produit
# qu'une seule taille.
function Save-MultiSizeIco([int[]]$sizes, [string]$path) {
    $images = @($sizes | ForEach-Object { ,(New-LogoBitmap $_) })
    $payload = @()
    $offset = 6 + 16 * $sizes.Count
    foreach ($b in $images) {
        # PNG pour toutes les tailles : compact, sans perte, et supporte alpha.
        $ms = New-Object System.IO.MemoryStream
        $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray(); $ms.Dispose()
        $payload += ,@{ Img = $b; Data = $bytes; Offset = $offset }
        $offset += $bytes.Length
    }
    $fs = [System.IO.File]::Create($path)
    $w = New-Object System.IO.BinaryWriter($fs)
    try {
        $w.Write([UInt16]0)          # reserved
        $w.Write([UInt16]1)          # type = icone
        $w.Write([UInt16]$sizes.Count)
        foreach ($p in $payload) {
            $sz = $p.Img.Width
            # 256 est encode 0 dans le format ICO
            $w.Write([byte]$(if ($sz -ge 256) { 0 } else { $sz }))
            $w.Write([byte]$(if ($sz -ge 256) { 0 } else { $sz }))
            $w.Write([byte]0)        # palette
            $w.Write([byte]0)        # reserved
            $w.Write([UInt16]1)      # planes
            $w.Write([UInt16]32)     # bpp
            $w.Write([UInt32]$p.Data.Length)
            $w.Write([UInt32]$p.Offset)
        }
        foreach ($p in $payload) { $w.Write($p.Data) }
    } finally { $w.Dispose(); $fs.Dispose() }
    foreach ($b in $images) { $b.Dispose() }
}

# --- Bandeau / logo de fin ------------------------------------------------
function Save-Panel24([string]$path, [int]$W, [int]$H, [bool]$WithTitle) {
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    # Fond blanc explicite : Inno n'utilise pas le canal alpha
    $g.Clear([System.Drawing.Color]::White)

    # Bloc logo + titre centre verticalement : centrer le logo seul laissait
    # les deux tiers inferieurs de la bandeau vides et desequilibres.
    $render = if ($W -le 55) { 220 } elseif ($W -le 100) { 400 } else { 500 }
    # L'icone occupe presque toute la viewBox 500 : a 80% de la largeur du
    # bandeau (164 px) le cercle exterieur touchait les bords. 70% laisse
    # une marge nette.
    $logoSize = if ($W -le 55) { [int]($H * 0.52) } else { [int]($W * 0.70) }
    $titleH = if ($WithTitle) { 30 } else { 0 }
    $gap = if ($WithTitle) { 6 } else { 0 }
    $blockH = $logoSize + $gap + $titleH
    $top = [int](($H - $blockH) / 2)
    if ($top -lt 0) { $top = 0 }

    $logo = New-LogoBitmap $render
    $x = [int](($W - $logoSize) / 2)
    $g.DrawImage($logo, $x, $top, $logoSize, $logoSize)
    $logo.Dispose()

    if ($WithTitle) {
        $font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold,
            [System.Drawing.GraphicsUnit]::Pixel)
        $tf = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.Point(0, 0)),
            (New-Object System.Drawing.Point($W, 0)), $Indigo, $Purple)
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = [System.Drawing.StringAlignment]::Center
        $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
        $rect = New-Object System.Drawing.RectangleF(0, ($top + $logoSize + $gap), $W, $titleH)
        $g.DrawString('LIA-X', $font, $tf, $rect, $sf)
        $sf.Dispose(); $tf.Dispose(); $font.Dispose()
    }
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
}

# --- Generation -----------------------------------------------------------
# Dimensions imposeses par Inno Setup / Windows pour l'assistant classique.
$jobs = @(
    @{ File = 'logo.ico';         Kind = 'ico'; Sizes = @(16, 24, 32, 48, 64, 128, 256) },
    @{ File = 'wizard.bmp';       Kind = 'bmp'; W = 164; H = 314; Title = $true  },
    @{ File = 'wizard-small.bmp'; Kind = 'bmp'; W = 55;  H = 58;  Title = $false },
    @{ File = 'logo-big.bmp';     Kind = 'bmp'; W = 100; H = 104; Title = $false }
)

foreach ($j in $jobs) {
    $out = Join-Path $PSScriptRoot $j.File
    if (-not $Force -and (Test-Path -LiteralPath $out)) {
        Write-Host ("  {0,-18} present, ignore (-Force pour regenérer)" -f $j.File) -ForegroundColor DarkGray
        continue
    }
    if ($j.Kind -eq 'ico') {
        Save-MultiSizeIco -sizes $j.Sizes -path $out
        Write-Host ("  {0,-18} {1} tailles ({2})" -f $j.File, $j.Sizes.Count, ($j.Sizes -join ', ')) -ForegroundColor Green
    } else {
        Save-Panel24 -path $out -W $j.W -H $j.H -WithTitle $j.Title
        Write-Host ("  {0,-18} {1}x{2} 24bpp" -f $j.File, $j.W, $j.H) -ForegroundColor Green
    }
}

Write-Host 'Assets régénérés.' -ForegroundColor Cyan
