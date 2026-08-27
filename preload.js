// DeepSeek Harness Desktop — preload
// 通过 contextBridge 暴露给页面注入的更新提示条使用。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  requestUpdate: () => ipcRenderer.invoke('dsh:request-update'),
  importSkill: () => ipcRenderer.invoke('dsh:import-skill'),
  checkUpdate: () => ipcRenderer.invoke('dsh:check-update'),
  // ---- 存储管理 ----
  skillsList: () => ipcRenderer.invoke('dsh:skills-list'),
  storageInfo: () => ipcRenderer.invoke('dsh:storage-info'),
  disksList: () => ipcRenderer.invoke('dsh:disks-list'),
  diskScan: (mount) => ipcRenderer.invoke('dsh:disk-scan', mount),
  cacheClear: () => ipcRenderer.invoke('dsh:cache-clear'),
  cacheChange: () => ipcRenderer.invoke('dsh:cache-change'),
  onSkillsChanged: (cb) => { ipcRenderer.on('dsh:skills-changed', () => cb()) },
  onDiskScanProgress: (cb) => { ipcRenderer.on('dsh:disk-scan-progress', (_e, p) => cb(p)) },
})
