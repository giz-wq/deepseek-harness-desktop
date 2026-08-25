// DeepSeek Harness Desktop — preload
// 通过 contextBridge 暴露给页面注入的更新提示条使用。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  requestUpdate: () => ipcRenderer.invoke('dsh:request-update'),
  importSkill: () => ipcRenderer.invoke('dsh:import-skill'),
  checkUpdate: () => ipcRenderer.invoke('dsh:check-update'),
})
