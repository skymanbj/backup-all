# Backup-All 自动备份总控（浏览器扩展 + 桌面软件）

## 一、浏览器扩展自动备份（8 个扩展）

每次打开 Chrome 浏览器时，自动延迟 15 秒触发已启用扩展的云同步与本地 JSON 备份，带实时进度条和完成通知。

1. 在 Chrome 地址栏输入 `chrome://extensions` 并回车；
2. 打开右上角 **开发者模式**，点 **加载已解压的扩展程序**，选择 `D:\Backup-All`；
3. 给已对接的 8 个扩展各点一次刷新（↻）：Cloudflare Information、Page Assist、BrowserBee 0.3.0、TabSpace 笔记本、Infinity New Tab、LaterOn 1.66.1、WuPage 翻译、Peerd 0.7.3。

本地导出文件自动保存在 Chrome 下载目录的 `Backup-All\年-月-日\`。

---

## 二、电脑桌面软件自动备份（Magpie / Lamp Guide / FreeLLMAPI）

- **脚本**：`D:\Backup-All\desktop-backup.ps1`
- **随时手动备份**：双击 `D:\Backup-All\一键备份桌面软件.bat`
- **开机自动运行**：已注册 Windows 计划任务 `Backup-All-Desktop`（登录后延迟 30 秒静默运行，完成后弹出桌面通知）
- **统一保存位置**：所有扩展导出文件与桌面软件备份统一保存在 `D:\Backup-All\Backups\年-月-日\`（自动保留最近 30 天）
  - **Magpie**：自动执行 `magpie webdav now` 云同步 + 打包 `C:\Users\Administrator\.config\magpie`
  - **Lamp Guide**：打包 `C:\Users\Administrator\AppData\Roaming\zen-gate`
  - **FreeLLMAPI**：打包 `C:\Users\Administrator\AppData\Roaming\FreeLLMAPI` 核心数据库与配置
