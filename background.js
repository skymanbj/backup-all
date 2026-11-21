importScripts('registry.js');

const { DEFAULT_TARGETS, DEFAULT_SETTINGS } = globalThis.BACKUP_ALL_DEFAULTS;

const STORAGE_KEYS = {
  TARGETS: 'ba_targets',
  SETTINGS: 'ba_settings',
  STATUS: 'ba_status',
  PROGRESS: 'ba_progress',
  LAST_AUTO_RUN: 'ba_last_auto_run',
  RUNNING: 'ba_running'
};

const STARTUP_ALARM = 'backup-all-startup-run';
const PER_EXTENSION_TIMEOUT_MS = 180000;

let isRunningInMemory = false;

// Service Worker 重新唤醒时清理可能遗留的卡住状态
void chrome.storage.local.set({ [STORAGE_KEYS.RUNNING]: false });

function formatDateFolder(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sanitizeFilename(name) {
  return String(name || 'backup.json')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '.')
    .slice(0, 120);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function getConfig() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.TARGETS,
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.STATUS,
    STORAGE_KEYS.LAST_AUTO_RUN
  ]);

  let targets = Array.isArray(stored[STORAGE_KEYS.TARGETS]) && stored[STORAGE_KEYS.TARGETS].length > 0
    ? stored[STORAGE_KEYS.TARGETS]
    : DEFAULT_TARGETS;

  // 自动补齐新增的默认项并确保桌面软件排在最顶部
  const existingIds = new Set(targets.map((t) => t.id));
  const missingDefaults = DEFAULT_TARGETS.filter((d) => !existingIds.has(d.id));
  let changed = false;
  if (missingDefaults.length > 0) {
    targets = [...missingDefaults, ...targets];
    changed = true;
  }
  const nativeIdx = targets.findIndex((t) => t.kind === 'native' || t.id === 'native:desktop-apps');
  if (nativeIdx > 0) {
    const [nativeItem] = targets.splice(nativeIdx, 1);
    targets = [nativeItem, ...targets];
    changed = true;
  }
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEYS.TARGETS]: targets });
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.SETTINGS] || {})
  };

  const statusMap = stored[STORAGE_KEYS.STATUS] || {};
  const lastAutoRun = stored[STORAGE_KEYS.LAST_AUTO_RUN] || 0;

  return { targets, settings, statusMap, lastAutoRun };
}

async function saveJsonToDownloads(filename, dataObj, mimeType) {
  const textStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj, null, 2);
  const safeName = sanitizeFilename(filename);
  const dateFolder = formatDateFolder();

  // 优先通过本机通道直接写入 D:\Backup-All\ExtensionBackups\日期\，彻底避免浏览器弹出“另存为 下载”窗口
  const nativeSaved = await new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(
        'com.backupall.desktop',
        { action: 'save_file', dateFolder, filename: safeName, content: textStr },
        (resp) => {
          if (chrome.runtime.lastError || !resp?.ok) resolve(null);
          else resolve(resp);
        }
      );
    } catch {
      resolve(null);
    }
  });

  if (nativeSaved?.path) {
    return { path: nativeSaved.path, viaNative: true };
  }

  // 兜底：使用浏览器下载
  const b64 = utf8ToBase64(textStr);
  const mime = mimeType || (safeName.endsWith('.toml') ? 'application/toml' : 'application/json');
  const dataUrl = `data:${mime};charset=utf-8;base64,${b64}`;
  const fullPath = `Backup-All/${dateFolder}/${safeName}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: fullPath,
        conflictAction: 'overwrite',
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve({ downloadId, path: fullPath, viaNative: false });
        }
      }
    );
  });
}

function sendBackupMessage(extensionId, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, message: `备份超时（超过 ${Math.round(PER_EXTENSION_TIMEOUT_MS / 1000)} 秒无响应）` });
      }
    }, PER_EXTENSION_TIMEOUT_MS);

    try {
      chrome.runtime.sendMessage(extensionId, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || '';
          if (errMsg.includes('Could not establish connection') || errMsg.includes('Receiving end does not exist')) {
            resolve({
              ok: false,
              message: '未连接（请确认扩展已启用，并在 chrome://extensions 点击刷新）'
            });
          } else {
            resolve({ ok: false, message: errMsg });
          }
          return;
        }
        if (!response || typeof response !== 'object') {
          resolve({ ok: false, message: '扩展未返回有效结果' });
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, message: err?.message || String(err) });
      }
    }
  });
}

function sendNativeDesktopBackup() {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, mode: 'desktop', message: '桌面软件备份超时（超过 120 秒）' });
      }
    }, 120000);

    try {
      chrome.runtime.sendNativeMessage(
        'com.backupall.desktop',
        { action: 'run_desktop_backup' },
        (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              mode: 'desktop',
              message: `本机通道未就绪：${chrome.runtime.lastError.message}`
            });
            return;
          }
          resolve(response || { ok: false, mode: 'desktop', message: '本机备份未返回结果' });
        }
      );
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, mode: 'desktop', message: err?.message || String(err) });
      }
    }
  });
}

async function runSingleTarget(target, trigger) {
  if (target.kind === 'native' || target.id === 'native:desktop-apps') {
    const resp = await sendNativeDesktopBackup();
    return {
      ok: Boolean(resp.ok),
      skipped: false,
      mode: 'desktop',
      message: resp.message || (resp.ok ? '桌面软件备份成功' : '桌面软件备份失败'),
      time: Date.now()
    };
  }

  const startedAt = Date.now();
  const resp = await sendBackupMessage(target.id, {
    type: 'BACKUP_ALL_TRIGGER',
    source: 'backup-all',
    trigger,
    timestamp: startedAt
  });

  let savedPath = '';
  if (resp.ok && resp.data !== undefined && resp.data !== null) {
    try {
      const fname = resp.filename || `${target.name.replace(/\s+/g, '-').toLowerCase()}-${formatDateFolder()}.json`;
      const saved = await saveJsonToDownloads(fname, resp.data, resp.mimeType);
      savedPath = saved.path;
    } catch (dlErr) {
      return {
        ok: false,
        skipped: false,
        mode: resp.mode || 'json',
        message: `保存本地文件失败：${dlErr.message}`,
        time: Date.now()
      };
    }
  }

  let message = resp.message || (resp.ok ? '备份成功' : '备份失败');
  if (savedPath) {
    message = `${message}（已存至 ${savedPath}）`;
  }

  return {
    ok: Boolean(resp.ok),
    skipped: Boolean(resp.skipped),
    mode: resp.mode || (resp.ok ? 'cloud' : 'error'),
    message,
    time: Date.now()
  };
}

async function updateBadge(okCount, failCount, skipCount) {
  if (failCount > 0 && okCount === 0) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  } else if (failCount > 0 || skipCount > 0) {
    await chrome.action.setBadgeText({ text: `${okCount}` });
    await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  } else if (okCount > 0) {
    await chrome.action.setBadgeText({ text: 'OK' });
    await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function runBackups({ trigger = 'manual', targetIds = null } = {}) {
  if (isRunningInMemory) {
    return { ok: false, message: '备份正在进行中，请稍候...' };
  }
  isRunningInMemory = true;
  await chrome.storage.local.set({ [STORAGE_KEYS.RUNNING]: true });
  await chrome.action.setBadgeText({ text: '...' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

  try {
    const { targets, settings, statusMap } = await getConfig();
    const list = targetIds
      ? targets.filter((t) => targetIds.includes(t.id))
      : targets.filter((t) => t.enabled);

    let okCount = 0;
    let failCount = 0;
    let skipCount = 0;
    const total = list.length;
    const failedNames = [];

    await chrome.storage.local.set({
      [STORAGE_KEYS.PROGRESS]: {
        running: true,
        total,
        completed: 0,
        currentName: total > 0 ? list[0].name : '',
        okCount: 0,
        failCount: 0,
        skipCount: 0,
        finishedAt: 0,
        summary: total > 0 ? `准备备份共 ${total} 个扩展...` : '没有已启用的扩展'
      }
    });

    for (let i = 0; i < list.length; i++) {
      const target = list[i];
      await chrome.action.setBadgeText({ text: `${i + 1}/${total}` });

      statusMap[target.id] = {
        ...(statusMap[target.id] || {}),
        running: true,
        message: '正在备份...'
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.STATUS]: statusMap,
        [STORAGE_KEYS.PROGRESS]: {
          running: true,
          total,
          completed: i,
          currentName: target.name,
          okCount,
          failCount,
          skipCount,
          finishedAt: 0,
          summary: `正在备份 (${i + 1}/${total})：${target.name}`
        }
      });

      const result = await runSingleTarget(target, trigger);
      statusMap[target.id] = { ...result, running: false };

      if (result.ok) okCount++;
      else if (result.skipped) skipCount++;
      else {
        failCount++;
        failedNames.push(target.name);
      }

      await chrome.storage.local.set({
        [STORAGE_KEYS.STATUS]: statusMap,
        [STORAGE_KEYS.PROGRESS]: {
          running: i + 1 < total,
          total,
          completed: i + 1,
          currentName: target.name,
          okCount,
          failCount,
          skipCount,
          finishedAt: i + 1 === total ? Date.now() : 0,
          summary: i + 1 < total
            ? `已完成 ${i + 1}/${total}，刚完成：${target.name}`
            : `备份完成：成功 ${okCount} 个${skipCount ? `，跳过 ${skipCount} 个` : ''}${failCount ? `，失败 ${failCount} 个` : ''}`
        }
      });
    }

    if (trigger === 'startup') {
      await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AUTO_RUN]: Date.now() });
    }

    await updateBadge(okCount, failCount, skipCount);

    if (settings.showNotifications && list.length > 0) {
      const parts = [`成功 ${okCount} 个`];
      if (skipCount > 0) parts.push(`跳过 ${skipCount} 个`);
      if (failCount > 0) parts.push(`失败 ${failCount} 个`);
      const failDetail = failedNames.length > 0 ? `\n失败项：${failedNames.join('、')}` : '';
      chrome.notifications.create(`backup-all-done-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: failCount > 0 ? 'Backup-All 备份完成（部分失败）' : 'Backup-All 全部备份完成',
        message: `${trigger === 'startup' ? '开机/启动自动备份' : '手动备份'}结束：${parts.join('，')}。${failDetail}`,
        priority: 2
      });
    }

    return { ok: true, okCount, failCount, skipCount };
  } finally {
    isRunningInMemory = false;
    await chrome.storage.local.set({ [STORAGE_KEYS.RUNNING]: false });
  }
}

async function scheduleStartupBackup() {
  const { settings, lastAutoRun } = await getConfig();
  if (!settings.autoRunOnStartup) return;

  const cooldownMs = (Number(settings.cooldownMinutes) || 0) * 60 * 1000;
  if (cooldownMs > 0 && Date.now() - lastAutoRun < cooldownMs) {
    console.log('[Backup-All] 冷却时间内，跳过本次启动自动备份');
    return;
  }

  const delayMin = Math.max(0.1, (Number(settings.startupDelaySec) || 15) / 60);
  await chrome.alarms.clear(STARTUP_ALARM);
  chrome.alarms.create(STARTUP_ALARM, { delayInMinutes: delayMin });
  console.log(`[Backup-All] 已计划在约 ${settings.startupDelaySec || 15} 秒后自动执行全部备份`);
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.TARGETS, STORAGE_KEYS.SETTINGS]);
  if (!Array.isArray(stored[STORAGE_KEYS.TARGETS]) || stored[STORAGE_KEYS.TARGETS].length === 0) {
    await chrome.storage.local.set({ [STORAGE_KEYS.TARGETS]: DEFAULT_TARGETS });
  }
  if (!stored[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleStartupBackup();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STARTUP_ALARM) {
    void runBackups({ trigger: 'startup' });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'PING') {
    sendResponse({ ok: true, running: isRunningInMemory });
    return false;
  }

  if (msg.type === 'RUN_ALL') {
    if (isRunningInMemory) {
      sendResponse({ ok: false, message: '备份正在进行中，请稍候...' });
      return false;
    }
    sendResponse({ ok: true, started: true, message: '已开始执行全部备份...' });
    void runBackups({ trigger: 'manual' });
    return false;
  }

  if (msg.type === 'RUN_ONE' && msg.targetId) {
    if (isRunningInMemory) {
      sendResponse({ ok: false, message: '备份正在进行中，请稍候...' });
      return false;
    }
    sendResponse({ ok: true, started: true, message: '已开始单独备份...' });
    void runBackups({ trigger: 'manual', targetIds: [msg.targetId] });
    return false;
  }

  if (msg.type === 'RESET_TARGETS') {
    void chrome.storage.local
      .set({ [STORAGE_KEYS.TARGETS]: DEFAULT_TARGETS, [STORAGE_KEYS.RUNNING]: false })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'BACKUP_ALL_OPEN_FOLDER') {
    try {
      chrome.runtime.sendNativeMessage('com.backupall.desktop', { action: 'open_folder' }, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, message: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: Boolean(resp?.ok) });
        }
      });
    } catch (err) {
      sendResponse({ ok: false, message: err?.message || String(err) });
    }
    return true;
  }
  return false;
});

// 接收其他扩展发来的“静默导出到固定备份目录”请求
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'BACKUP_ALL_SAVE_FILE' && msg.filename && msg.content !== undefined) {
    (async () => {
      try {
        const saved = await saveJsonToDownloads(msg.filename, msg.content, msg.mimeType);
        sendResponse({ ok: true, path: saved.path, viaNative: saved.viaNative });
      } catch (err) {
        sendResponse({ ok: false, message: err?.message || String(err) });
      }
    })();
    return true;
  }
  if (msg.type === 'BACKUP_ALL_OPEN_FOLDER') {
    try {
      chrome.runtime.sendNativeMessage('com.backupall.desktop', { action: 'open_folder' }, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, message: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: Boolean(resp?.ok) });
        }
      });
    } catch (err) {
      sendResponse({ ok: false, message: err?.message || String(err) });
    }
    return true;
  }
  return false;
});
