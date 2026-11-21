# Backup-All 桌面软件自动备份脚本（Magpie / Lamp Guide / FreeLLMAPI）
param(
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$backupRoot = 'D:\Backup-All\Backups'
$dateStr = Get-Date -Format 'yyyy-MM-dd'
$timeStr = Get-Date -Format 'HH:mm:ss'
$todayDir = Join-Path $backupRoot $dateStr
$logFile = Join-Path $backupRoot 'backup.log'
$tempRoot = Join-Path $env:TEMP ("backup-all-staging-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

New-Item -ItemType Directory -Path $todayDir -Force | Out-Null
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

function Write-Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  if (-not $Silent) { Write-Host $msg }
}

function Show-Notification($title, $body, $isError = $false) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = if ($isError) { [System.Drawing.SystemIcons]::Warning } else { [System.Drawing.SystemIcons]::Information }
    $notify.BalloonTipIcon = if ($isError) { [System.Windows.Forms.ToolTipIcon]::Warning } else { [System.Windows.Forms.ToolTipIcon]::Info }
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = $body
    $notify.Visible = $true
    $notify.ShowBalloonTip(8000)
    Start-Sleep -Milliseconds 1500
    $notify.Dispose()
  } catch {
    Write-Log "通知显示失败: $($_.Exception.Message)"
  }
}

function Copy-ItemSafe($src, $dst) {
  if (-not (Test-Path $src)) { return $false }
  $parent = Split-Path -Parent $dst
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  try {
    Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
    return $true
  } catch {
    # 文件可能被占用（如 SQLite DB），使用只读流复制
    try {
      $inStream = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $outStream = [System.IO.File]::Create($dst)
        try { $inStream.CopyTo($outStream) } finally { $outStream.Dispose() }
      } finally { $inStream.Dispose() }
      return $true
    } catch {
      return $false
    }
  }
}

function Compress-FolderToZip($sourceDir, $zipPath) {
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($sourceDir, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
}

$results = @()
Write-Log "========== 开始桌面软件备份 ($dateStr $timeStr) =========="

# ---------------------------------------------------------
# 1/3 Magpie (WebDAV 同步 + 本地配置打包)
# ---------------------------------------------------------
Write-Log "[1/3] 正在备份 Magpie..."
try {
  $magpieExe = 'D:\Download\magpie-windows-amd64.exe'
  $magpieData = Join-Path $env:USERPROFILE '.config\magpie'
  $webdavNote = ''

  if (Test-Path $magpieExe) {
    $proc = Start-Process -FilePath $magpieExe -ArgumentList 'webdav', 'now' -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $tempRoot 'magpie_out.txt') -RedirectStandardError (Join-Path $tempRoot 'magpie_err.txt')
    if ($proc.WaitForExit(30000)) {
      if ($proc.ExitCode -eq 0) {
        $webdavNote = 'WebDAV 同步成功 + '
      } else {
        $webdavNote = 'WebDAV 未启用/跳过 + '
      }
    } else {
      try { $proc.Kill() } catch {}
      $webdavNote = 'WebDAV 超时跳过 + '
    }
  }

  if (Test-Path $magpieData) {
    $stage = Join-Path $tempRoot 'magpie'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Get-ChildItem -Path $magpieData -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
      $_.Extension -ne '.lock' -and $_.Name -notlike '*.lock'
    } | ForEach-Object {
      $rel = $_.FullName.Substring($magpieData.Length + 1)
      Copy-ItemSafe $_.FullName (Join-Path $stage $rel) | Out-Null
    }
    $zipPath = Join-Path $todayDir "magpie-config-$dateStr.zip"
    Compress-FolderToZip $stage $zipPath
    $sizeKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    $msg = "${webdavNote}本地配置已打包 (${sizeKB} KB)"
    Write-Log "  [成功] Magpie: $msg"
    $results += [pscustomobject]@{ Name = 'Magpie'; Ok = $true; Msg = $msg }
  } else {
    throw "未找到数据目录 $magpieData"
  }
} catch {
  $err = $_.Exception.Message
  Write-Log "  [失败] Magpie: $err"
  $results += [pscustomobject]@{ Name = 'Magpie'; Ok = $false; Msg = $err }
}

# ---------------------------------------------------------
# 2/3 Lamp Guide (%APPDATA%\zen-gate)
# ---------------------------------------------------------
Write-Log "[2/3] 正在备份 Lamp Guide..."
try {
  $lampData = Join-Path $env:APPDATA 'zen-gate'
  if (-not (Test-Path $lampData)) { throw "未找到数据目录 $lampData" }

  $stage = Join-Path $tempRoot 'lamp-guide'
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  Get-ChildItem -Path $lampData -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
    $_.FullName -notmatch '\\logs\\'
  } | ForEach-Object {
    $rel = $_.FullName.Substring($lampData.Length + 1)
    Copy-ItemSafe $_.FullName (Join-Path $stage $rel) | Out-Null
  }
  $zipPath = Join-Path $todayDir "lamp-guide-$dateStr.zip"
  Compress-FolderToZip $stage $zipPath
  $sizeKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  $msg = "配置与数据已打包 (${sizeKB} KB)"
  Write-Log "  [成功] Lamp Guide: $msg"
  $results += [pscustomobject]@{ Name = 'Lamp Guide'; Ok = $true; Msg = $msg }
} catch {
  $err = $_.Exception.Message
  Write-Log "  [失败] Lamp Guide: $err"
  $results += [pscustomobject]@{ Name = 'Lamp Guide'; Ok = $false; Msg = $err }
}

# ---------------------------------------------------------
# 3/3 FreeLLMAPI (%APPDATA%\FreeLLMAPI)
# ---------------------------------------------------------
Write-Log "[3/3] 正在备份 FreeLLMAPI..."
try {
  $freeData = Join-Path $env:APPDATA 'FreeLLMAPI'
  if (-not (Test-Path $freeData)) { throw "未找到数据目录 $freeData" }

  $stage = Join-Path $tempRoot 'freellmapi'
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  $coreFiles = @('freeapi.db', 'freeapi.db-wal', 'freeapi.db-shm', 'config.json', '.encryption-key')
  $copiedCount = 0
  foreach ($cf in $coreFiles) {
    $src = Join-Path $freeData $cf
    if (Copy-ItemSafe $src (Join-Path $stage $cf)) { $copiedCount++ }
  }

  $backupsSub = Join-Path $freeData 'backups'
  if (Test-Path $backupsSub) {
    Get-ChildItem -Path $backupsSub -File -ErrorAction SilentlyContinue | ForEach-Object {
      if (Copy-ItemSafe $_.FullName (Join-Path $stage ("backups\" + $_.Name))) { $copiedCount++ }
    }
  }

  if ($copiedCount -eq 0) { throw "未找到可备份的核心文件" }

  $zipPath = Join-Path $todayDir "freellmapi-$dateStr.zip"
  Compress-FolderToZip $stage $zipPath
  $sizeKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  $msg = "数据库与配置已打包，共 $copiedCount 个文件 (${sizeKB} KB)"
  Write-Log "  [成功] FreeLLMAPI: $msg"
  $results += [pscustomobject]@{ Name = 'FreeLLMAPI'; Ok = $true; Msg = $msg }
} catch {
  $err = $_.Exception.Message
  Write-Log "  [失败] FreeLLMAPI: $err"
  $results += [pscustomobject]@{ Name = 'FreeLLMAPI'; Ok = $false; Msg = $err }
}

# ---------------------------------------------------------
# 4/4 FMH (D:\Free-Model-Hub)
# ---------------------------------------------------------
Write-Log "[4/4] 正在备份 FMH (Free-Model-Hub)..."
try {
  $fmhRoot = 'D:\Free-Model-Hub'
  if (-not (Test-Path $fmhRoot)) { throw "未找到目录 $fmhRoot" }

  $stage = Join-Path $tempRoot 'fmh'
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $copiedCount = 0
  foreach ($cf in @('free_models.db', 'free_models.db-wal', 'free_models.db-shm')) {
    if (Copy-ItemSafe (Join-Path $fmhRoot $cf) (Join-Path $stage $cf)) { $copiedCount++ }
  }
  $fmhData = Join-Path $fmhRoot 'data'
  if (Test-Path $fmhData) {
    Get-ChildItem -Path $fmhData -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      $rel = $_.FullName.Substring($fmhData.Length + 1)
      if (Copy-ItemSafe $_.FullName (Join-Path $stage ("data\" + $rel))) { $copiedCount++ }
    }
  }
  if ($copiedCount -eq 0) { throw "未找到可备份的 FMH 数据文件" }

  $zipPath = Join-Path $todayDir "fmh-backup-$dateStr.zip"
  Compress-FolderToZip $stage $zipPath
  $sizeKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  $msg = "数据库与数据已打包，共 $copiedCount 个文件 (${sizeKB} KB)"
  Write-Log "  [成功] FMH: $msg"
  $results += [pscustomobject]@{ Name = 'FMH'; Ok = $true; Msg = $msg }
} catch {
  $err = $_.Exception.Message
  Write-Log "  [失败] FMH: $err"
  $results += [pscustomobject]@{ Name = 'FMH'; Ok = $false; Msg = $err }
}

# 清理临时目录
Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue

# 自动清理超过 30 天的旧备份目录
Get-ChildItem -Path $backupRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^\d{4}-\d{2}-\d{2}$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-30)
} | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 汇总并弹窗通知
$totalCount = $results.Count
$okCount = ($results | Where-Object { $_.Ok }).Count
$failList = $results | Where-Object { -not $_.Ok }
$failCount = $failList.Count

$summary = "成功 $okCount/$totalCount 个"
if ($failCount -gt 0) {
  $summary += "，失败：" + (($failList | ForEach-Object { $_.Name }) -join '、')
}
$summary += "`n保存位置：$todayDir"

Write-Log "========== 备份完成：$summary =========="
Show-Notification -title $(if ($failCount -gt 0) { 'Backup-All 桌面备份完成（有失败）' } else { 'Backup-All 桌面备份全部完成' }) -body $summary -isError ($failCount -gt 0)
