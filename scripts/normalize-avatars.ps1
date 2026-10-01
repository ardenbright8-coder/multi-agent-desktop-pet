# 小人素材归一化 —— 把 avatars\*.png 统一摆正，跑一次就行。
#
# 为什么要有这个脚本（2026-08-14）：
#   AI 生的表情图每张构图都不一样——小人有的在画布正中、有的偏左三分之一，
#   周围的思考泡/星星/飘叶又占掉大半画布。直接贴到座位上，同一个座位里
#   小人会左右乱跳，还会伸出去压住隔壁工位的键盘和显示器。
#   界面层没法算包围盒（CSS 只认整张图），所以归一化必须在素材这一层做。
#
# 干了什么：
#   1. 只按**绿色像素**找小人本体（星星是黄的、思考泡是白的、爱心是红的，都不算），
#      再用「列/行直方图取含中位线的连续段」滤掉飘在旁边的零星小绿叶。
#   2. 以本体为准重新裁一张正方形画布：本体水平居中、底边留一点点边，
#      本体宽度固定占画布 BODY_RATIO。装饰跟着原位置保留，超出画布的裁掉。
#   3. 原图先备份到 _素材暂存\_原始512备份\，覆盖前一定留底。
#
# 以后往 avatars\ 导了新图，跑一遍这个脚本再上机。
# 用法：pwsh -File scripts\normalize-avatars.ps1

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root "src\pet\renderer\assets\avatars"
$backup = Join-Path $dir "_素材暂存（紫底=透明·未处理）\_原始512备份"

# 本体宽度占成品画布的比例。留下的余量给思考泡/星星这类装饰，
# 0.62 ≈ 本体两侧各留 19%，实测思考泡刚好收得住又不至于把小人挤太小。
$BODY_RATIO = 0.62
# 本体底边距画布底的比例（留一丝，免得贴边看着像被切了）
$BOTTOM_PAD = 0.04

if (-not (Test-Path $backup)) { New-Item -ItemType Directory -Path $backup -Force | Out-Null }

function Get-BodyBox([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $colCount = New-Object 'int[]' $w
  $rowCount = New-Object 'int[]' $h
  $total = 0
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $c = $bmp.GetPixel($x, $y)
      # 绿色小人：G 明显压过 R 和 B。阈值 18 能吃下暗部描边，又挡得住黄星星和白泡泡。
      if ($c.A -gt 128 -and $c.G -gt ($c.R + 18) -and $c.G -gt ($c.B + 18)) {
        $colCount[$x]++; $rowCount[$y]++; $total++
      }
    }
  }
  if ($total -lt 50) { return $null }

  # 含「中位线」的连续段 = 小人本体所在那一坨；
  # 孤零零飘在旁边的小绿叶不连着中位线，自然被甩掉。
  function Segment($counts, $len) {
    $max = 0; foreach ($c in $counts) { if ($c -gt $max) { $max = $c } }
    $thr = [Math]::Max(1, [int]($max * 0.15))
    $peak = 0; for ($i = 0; $i -lt $len; $i++) { if ($counts[$i] -gt $counts[$peak]) { $peak = $i } }
    $lo = $peak; while ($lo -gt 0 -and $counts[$lo - 1] -ge $thr) { $lo-- }
    $hi = $peak; while ($hi -lt $len - 1 -and $counts[$hi + 1] -ge $thr) { $hi++ }
    return @($lo, $hi)
  }
  $cs = Segment $colCount $w
  $rs = Segment $rowCount $h
  return [PSCustomObject]@{ X = $cs[0]; Y = $rs[0]; W = $cs[1] - $cs[0] + 1; H = $rs[1] - $rs[0] + 1 }
}

Get-ChildItem $dir -Filter *.png -File | ForEach-Object {
  $src = $_.FullName
  $bak = Join-Path $backup $_.Name
  if (-not (Test-Path $bak)) { Copy-Item $src $bak }

  $img = [System.Drawing.Bitmap]::FromFile($bak)   # 永远从备份原件重算，反复跑不会越裁越小
  $box = Get-BodyBox $img
  if ($null -eq $box) { "跳过（找不到绿色本体）: $($_.Name)"; $img.Dispose(); return }

  # 成品画布边长：让本体宽度正好占 BODY_RATIO
  $side = [int][Math]::Round($box.W / $BODY_RATIO)
  # 画布在原图里的位置：本体水平居中，本体底边距画布底 BOTTOM_PAD
  $srcX = [int][Math]::Round($box.X + $box.W / 2.0 - $side / 2.0)
  $srcY = [int][Math]::Round($box.Y + $box.H + $side * $BOTTOM_PAD - $side)

  $out = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  # 画布可能超出原图边界，超出部分留透明即可
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $side, $side)),
    $srcX, $srcY, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $img.Dispose()

  $out.Save($src, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  "{0,-22} 本体 {1}x{2} @({3},{4}) → 画布 {5}²" -f $_.Name, $box.W, $box.H, $box.X, $box.Y, $side
}
