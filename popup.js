const { DEFAULT_TARGETS, DEFAULT_SETTINGS } = globalThis.BACKUP_ALL_DEFAULTS;

const STORAGE_KEYS = {
  TARGETS: 'ba_targets',
  SETTINGS: 'ba_settings',
  STATUS: 'ba_status',
  PROGRESS: 'ba_progress',
  RUNNING: 'ba_running'
};

const runAllBtn = document.getElementById('runAllBtn');
const noticeBar = document.getElementById('noticeBar');
const progressCard = document.getElementById('progressCard');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');
const progressFill = document.getElementById('progressFill');
const autoRunToggle = document.getElementById('autoRunToggle');
const cooldownSelect = document.getElementById('cooldownSelect');
const summaryText = document.getElementById('summaryText');
const targetList = document.getElementById('targetList');
const openDownloadsBtn = document.getElementById('openDownloadsBtn');
const addExtBtn = document.getElementById('addExtBtn');
const resetBtn = document.getElementById('resetBtn');
const newExtName = document.getElementById('newExtName');
const newExtId = document.getElementById('newExtId');

let renderQueued = false;
let rendering = false;

function showNotice(text, isError = false) {
  if (!noticeBar) return;
  if (!text) {
    noticeBar.hidden = true;
    noticeBar.textContent = '';
    noticeBar.classList.remove('error');
    return;
  }
  noticeBar.hidden = false;
  noticeBar.textContent = text;
  noticeBar.classList.toggle('error', isError);
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.TARGETS,
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.STATUS,
    STORAGE_KEYS.PROGRESS,
    STORAGE_KEYS.RUNNING
  ]);
  let targets = Array.isArray(stored[STORAGE_KEYS.TARGETS]) && stored[STORAGE_KEYS.TARGETS].length > 0
    ? stored[STORAGE_KEYS.TARGETS]
    : DEFAULT_TARGETS;
  const defaultById = new Map(DEFAULT_TARGETS.map((d) => [d.id, d]));
  const existingIds = new Set(targets.map((t) => t.id));
  const missingDefaults = DEFAULT_TARGETS.filter((d) => !existingIds.has(d.id));
  let changed = false;
  targets = targets.map((t) => {
    const def = defaultById.get(t.id);
    if (def && (t.desc !== def.desc || t.name !== def.name)) {
      changed = true;
      return { ...t, name: def.name, desc: def.desc };
    }
    return t;
  });
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
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };
  const statusMap = stored[STORAGE_KEYS.STATUS] || {};
  const progress = stored[STORAGE_KEYS.PROGRESS] || null;
  const isRunning = Boolean(stored[STORAGE_KEYS.RUNNING]);
  return { targets, settings, statusMap, progress, isRunning };
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, message: `后台服务无响应：${chrome.runtime.lastError.message}` });
          return;
        }
        resolve(resp || { ok: false, message: '后台未返回结果' });
      });
    } catch (err) {
      resolve({ ok: false, message: `发送指令失败：${err?.message || err}` });
    }
  });
}

async function triggerBackup(message) {
  showNotice('正在启动备份，请稍候...');
  const resp = await sendToBackground(message);
  if (!resp.ok) {
    showNotice(resp.message || '启动备份失败，请到 chrome://extensions 刷新本扩展', true);
  } else {
    showNotice(resp.message || '备份已开始，下方列表会实时更新进度');
  }
  scheduleRender();
}

function scheduleRender() {
  if (rendering) {
    renderQueued = true;
    return;
  }
  void render();
}

async function render() {
  rendering = true;
  try {
    const { targets, settings, statusMap, progress, isRunning } = await loadState();

    autoRunToggle.checked = Boolean(settings.autoRunOnStartup);
    cooldownSelect.value = String(settings.cooldownMinutes ?? 30);

    runAllBtn.disabled = isRunning;
    runAllBtn.textContent = isRunning ? '正在备份...' : '立即全部备份';

    if (progress && progress.total > 0) {
      const pct = Math.min(100, Math.round((progress.completed / progress.total) * 100));
      progressCard.hidden = false;
      progressCard.classList.remove('done-ok', 'done-warn');
      if (!isRunning && progress.completed >= progress.total) {
        progressCard.classList.add(progress.failCount > 0 || progress.skipCount > 0 ? 'done-warn' : 'done-ok');
        const timeStr = progress.finishedAt ? ` · ${formatTime(progress.finishedAt)}` : '';
        progressText.textContent = `${progress.failCount > 0 ? '⚠️ ' : '✅ '}${progress.summary}${timeStr}`;
      } else {
        progressText.textContent = progress.summary || `正在备份 (${progress.completed}/${progress.total})...`;
      }
      progressPercent.textContent = `${progress.completed}/${progress.total} (${pct}%)`;
      progressFill.style.width = `${pct}%`;
      if (isRunning) {
        showNotice('');
      }
    } else {
      progressCard.hidden = true;
    }

    const enabledCount = targets.filter((t) => t.enabled).length;
    summaryText.textContent = `已启用 ${enabledCount} / ${targets.length} 个扩展`;

    const frag = document.createDocumentFragment();
    for (const target of targets) {
      const st = statusMap[target.id];
      const li = document.createElement('li');
      li.className = 'target-item';

      const top = document.createElement('div');
      top.className = 'target-top';

      const left = document.createElement('label');
      left.className = 'target-left';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(target.enabled);
      cb.addEventListener('change', async () => {
        const state = await loadState();
        const updated = state.targets.map((t) =>
          t.id === target.id ? { ...t, enabled: cb.checked } : t
        );
        await chrome.storage.local.set({ [STORAGE_KEYS.TARGETS]: updated });
        scheduleRender();
      });

      const info = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'target-name';
      nameEl.textContent = target.name;
      const descEl = document.createElement('div');
      descEl.className = 'target-desc';
      descEl.textContent = target.desc || target.id;
      info.appendChild(nameEl);
      info.appendChild(descEl);

      left.appendChild(cb);
      left.appendChild(info);

      const runOneBtn = document.createElement('button');
      runOneBtn.className = 'btn-small';
      runOneBtn.textContent = '单独备份';
      runOneBtn.disabled = isRunning;
      runOneBtn.addEventListener('click', () => {
        void triggerBackup({ type: 'RUN_ONE', targetId: target.id });
      });

      top.appendChild(left);
      top.appendChild(runOneBtn);
      li.appendChild(top);

      const statusRow = document.createElement('div');
      statusRow.className = 'target-status';

      const badge = document.createElement('span');
      const msg = document.createElement('span');
      msg.className = 'status-msg';

      if (st?.running) {
        badge.className = 'badge badge-run';
        badge.textContent = '备份中';
        msg.textContent = st.message || '正在执行...';
      } else if (st?.ok) {
        badge.className = 'badge badge-ok';
        badge.textContent = '成功';
        msg.textContent = `${formatTime(st.time)} · ${st.message || '已完成'}`;
      } else if (st?.skipped) {
        badge.className = 'badge badge-skip';
        badge.textContent = '跳过';
        msg.textContent = `${formatTime(st.time)} · ${st.message || '已跳过'}`;
      } else if (st && st.ok === false) {
        badge.className = 'badge badge-fail';
        badge.textContent = '失败';
        msg.textContent = `${formatTime(st.time)} · ${st.message || '失败'}`;
      } else {
        badge.className = 'badge badge-idle';
        badge.textContent = '未运行';
        msg.textContent = '等待浏览器启动或手动触发';
      }

      statusRow.appendChild(badge);
      statusRow.appendChild(msg);
      li.appendChild(statusRow);
      frag.appendChild(li);
    }

    targetList.innerHTML = '';
    targetList.appendChild(frag);
  } finally {
    rendering = false;
    if (renderQueued) {
      renderQueued = false;
      void render();
    }
  }
}

runAllBtn.addEventListener('click', () => {
  void triggerBackup({ type: 'RUN_ALL' });
});

autoRunToggle.addEventListener('change', async () => {
  const { settings } = await loadState();
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { ...settings, autoRunOnStartup: autoRunToggle.checked }
  });
});

cooldownSelect.addEventListener('change', async () => {
  const { settings } = await loadState();
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { ...settings, cooldownMinutes: Number(cooldownSelect.value) }
  });
});

openDownloadsBtn.addEventListener('click', () => {
  chrome.runtime.sendNativeMessage('com.backupall.desktop', { action: 'open_folder' }, () => {
    if (chrome.runtime.lastError) {
      chrome.downloads.showDefaultFolder();
    }
  });
});

addExtBtn.addEventListener('click', async () => {
  const name = newExtName.value.trim();
  const id = newExtId.value.trim().toLowerCase();
  if (!name || !/^[a-p]{32}$/.test(id)) {
    showNotice('请填写扩展名称，以及正确的 32 位 Chrome 扩展 ID', true);
    return;
  }
  const { targets } = await loadState();
  if (targets.some((t) => t.id === id)) {
    showNotice('该扩展已在列表中', true);
    return;
  }
  targets.push({ id, name, desc: '自定义扩展', enabled: true });
  await chrome.storage.local.set({ [STORAGE_KEYS.TARGETS]: targets });
  newExtName.value = '';
  newExtId.value = '';
  showNotice(`已添加扩展：${name}`);
  scheduleRender();
});

resetBtn.addEventListener('click', async () => {
  const resp = await sendToBackground({ type: 'RESET_TARGETS' });
  if (resp.ok) showNotice('已恢复默认 8 个扩展');
  else showNotice(resp.message || '恢复失败', true);
  scheduleRender();
});

chrome.storage.onChanged.addListener(() => {
  scheduleRender();
});

scheduleRender();
