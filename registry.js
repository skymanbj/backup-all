(() => {
  // 默认已对接的桌面软件 + 8 个 Chrome 扩展配置
  const DEFAULT_TARGETS = [
    {
      id: 'native:desktop-apps',
      name: '桌面软件（Magpie / Lamp Guide / FreeLLMAPI）',
      desc: '调用本机一键备份脚本（保存至 D:\\Backup-All\\Backups）',
      kind: 'native',
      enabled: true
    },
    {
      id: 'emddmkmopojaccilkdfjjgdhmnmppbbg',
      name: 'Cloudflare Information',
      desc: 'GitHub 云同步 / 本地 JSON',
      enabled: true
    },
    {
      id: 'fckfbciakpblmiikhkhnbomnmnchjneo',
      name: 'Page Assist',
      desc: 'WebDAV / Google Drive 云同步',
      enabled: true
    },
    {
      id: 'imdfblichjocpcmhmfjkfhaecocdpoja',
      name: 'BrowserBee 0.3.0',
      desc: 'WebDAV / Google Drive 云同步',
      enabled: true
    },
    {
      id: 'dnecaacgnnlhpenghacnhjcfkdnjbdnd',
      name: 'TabSpace 笔记本',
      desc: 'Google Drive 同步 + 本地 JSON',
      enabled: true
    },
    {
      id: 'bhnmneenfckboiobpcobmgoabapbadjb',
      name: 'Infinity New Tab',
      desc: 'WebDAV 同步 / 本地 JSON',
      enabled: true
    },
    {
      id: 'aohjlidibldjlapefjdjnocingdgmagl',
      name: 'LaterOn 1.66.1',
      desc: '本地 JSON 收藏备份',
      enabled: true
    },
    {
      id: 'fgeedjpifhmkdehbgdmngbehdfcflblc',
      name: 'WuPage 翻译',
      desc: '原生 TOML 设置备份',
      enabled: true
    },
    {
      id: 'ccpcaadkmkcbjihhmnhfpfhfhpahijbc',
      name: 'Peerd 0.7.3',
      desc: '本地 JSON 非敏感配置备份',
      enabled: true
    }
  ];

  const DEFAULT_SETTINGS = {
    autoRunOnStartup: true,
    startupDelaySec: 15,
    cooldownMinutes: 30,
    showNotifications: true
  };

  globalThis.BACKUP_ALL_DEFAULTS = { DEFAULT_TARGETS, DEFAULT_SETTINGS };
})();
