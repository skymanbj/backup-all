const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function sanitizeName(name) {
  return String(name || 'backup.json')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '.')
    .slice(0, 150);
}

function runDesktopBackup() {
  const scriptPath = 'D:\\Backup-All\\desktop-backup.ps1';
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, '-Silent'],
    { timeout: 120000, windowsHide: true },
    (error) => {
      if (error) {
        sendMessage({
          ok: false,
          mode: 'desktop',
          message: `执行桌面备份脚本失败：${error.message}`
        });
        process.exit(0);
        return;
      }

      let summary = 'Magpie / Lamp Guide / FreeLLMAPI 备份完成';
      try {
        const logPath = 'D:\\Backup-All\\Backups\\backup.log';
        if (fs.existsSync(logPath)) {
          const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
          const lastDone = [...lines].reverse().find((l) => l.includes('备份完成：'));
          if (lastDone) {
            summary = lastDone.replace(/^\[[^\]]+\]\s*=*\s*/, '').replace(/\s*=*$/, '');
          }
        }
      } catch {}

      sendMessage({
        ok: true,
        mode: 'desktop',
        message: summary
      });
      process.exit(0);
    }
  );
}

function saveBackupFile(msg) {
  try {
    const folder = /^\d{4}-\d{2}-\d{2}$/.test(String(msg.dateFolder || ''))
      ? msg.dateFolder
      : new Date().toISOString().slice(0, 10);
    const dir = path.join('D:\\Backup-All\\Backups', folder);
    fs.mkdirSync(dir, { recursive: true });
    const file = sanitizeName(msg.filename);
    const fullPath = path.join(dir, file);
    fs.writeFileSync(fullPath, String(msg.content ?? ''), 'utf8');
    sendMessage({ ok: true, path: fullPath });
  } catch (err) {
    sendMessage({ ok: false, message: err?.message || String(err) });
  }
  process.exit(0);
}

function openBackupFolder() {
  try {
    fs.mkdirSync('D:\\Backup-All\\Backups', { recursive: true });
    execFile('explorer.exe', ['D:\\Backup-All\\Backups'], { windowsHide: false });
    sendMessage({ ok: true });
  } catch (err) {
    sendMessage({ ok: false, message: err?.message || String(err) });
  }
  process.exit(0);
}

let buf = Buffer.alloc(0);
let expectedLen = null;

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (expectedLen === null && buf.length >= 4) {
    expectedLen = buf.readUInt32LE(0);
    buf = buf.subarray(4);
  }
  if (expectedLen !== null && buf.length >= expectedLen) {
    const raw = buf.subarray(0, expectedLen).toString('utf8');
    let msg = {};
    try { msg = JSON.parse(raw); } catch {}
    if (msg.action === 'run_desktop_backup') {
      runDesktopBackup();
    } else if (msg.action === 'save_file') {
      saveBackupFile(msg);
    } else if (msg.action === 'open_folder') {
      openBackupFolder();
    } else {
      sendMessage({ ok: true, message: 'native host ready' });
      process.exit(0);
    }
  }
});
