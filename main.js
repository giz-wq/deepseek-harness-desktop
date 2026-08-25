// DeepSeek Harness Desktop — Electron 主进程
// 后台拉起 `dsh web` 本地服务，解析实际端口后在 BrowserWindow 中加载 Web UI。
// 附带功能：GitHub 更新检查 + skill 导入。
const { app, BrowserWindow, dialog, shell, Menu, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// dsh CLI 入口（npm 包 @deepseek-ai/dsh 的 bin）
const DSH_BIN = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const STARTUP_TIMEOUT_MS = 90_000
const URL_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:(\d+))/

// ---- 本项目更新配置 ----
const GITHUB_REPO = 'giz-wq/deepseek-harness-desktop'        // 远端仓库
const APP_VERSION = require('./package.json').version        // 本地版本
const SKILLS_DIR = path.join(os.homedir(), '.dsh', 'skills') // dsh 用户级 skill 根目录

let serverProcess = null
let mainWindow = null
let serverStderrTail = []

// ---- 单实例：重复启动时聚焦已有窗口 ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// ---- 后台服务进程管理 ----
function startServer() {
  console.log('[dsh-desktop] spawning:', process.execPath, DSH_BIN)
  serverProcess = spawn(process.execPath, ['--expose-internals', DSH_BIN, 'web', '--no-open', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  serverProcess.stdout.setEncoding('utf8')
  serverProcess.stderr.setEncoding('utf8')
  serverProcess.stdout.on('data', chunk => console.log(`[dsh] ${chunk.trimEnd()}`))
  serverProcess.stderr.on('data', chunk => {
    serverStderrTail.push(chunk)
    if (serverStderrTail.length > 50) serverStderrTail.shift()
    console.log(`[dsh:err] ${chunk.trimEnd()}`)
  })
  serverProcess.on('exit', (code) => {
    console.log(`[dsh] server exited with code ${code}`)
  })

  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error('启动 dsh 服务超时')),
      STARTUP_TIMEOUT_MS,
    )

    const onData = (chunk) => {
      buffer += chunk
      const match = buffer.match(URL_PATTERN)
      if (match) {
        serverProcess.stdout.off('data', onData)
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    serverProcess.stdout.on('data', onData)

    serverProcess.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== null && code !== 0) {
        reject(new Error(`dsh 服务异常退出（code ${code}）\n${serverStderrTail.join('')}`))
      }
    })
  })
}

function stopServer() {
  if (serverProcess === null || serverProcess.killed) return
  try {
    process.kill(-serverProcess.pid, 'SIGTERM')
  } catch {
    try { serverProcess.kill('SIGTERM') } catch { /* 已退出 */ }
  }
  serverProcess = null
}

// ---- 等待 HTTP 就绪 ----
function waitHttpReady(url, timeoutMs = 30_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error('等待 dsh Web UI 就绪超时'))
        } else {
          setTimeout(attempt, 300)
        }
      })
    }
    attempt()
  })
}

// ---- 版本比较：将 tag 解析为数值数组，a 是否比 b 新 ----
function parseVersion(tag) {
  const raw = String(tag ?? '').replace(/^v/, '').trim()
  if (!raw) return [0]
  return raw.split('.').map(Number)
}
function isNewer(lhs, rhs) {
  const a = parseVersion(lhs)
  const b = parseVersion(rhs)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

// ---- 向 dsh Web 页面顶部居中注入更新提示条 ----
function buildUpdateBannerHtml(newVersion) {
  return `
  <div id="dsh-update-banner" style="position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:12px;padding:12px 16px 12px 20px;border-radius:14px;background:rgba(28,28,32,0.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 8px 30px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <span style="color:#f2f2f5;font-size:14px;font-weight:500;white-space:nowrap;">发现新版本 ${newVersion}</span>
    <button id="dsh-update-btn" style="cursor:pointer;border:none;border-radius:8px;padding:7px 18px;font-size:13px;font-weight:600;color:#ffffff;background:#1f1f22;box-shadow:0 2px 12px rgba(0,0,0,0.35);transition:transform .18s ease,box-shadow .18s ease;animation:dshPulse 2s ease-in-out infinite;">更新</button>
    <button id="dsh-update-close" style="cursor:pointer;border:none;background:transparent;color:#a1a1ab;font-size:18px;line-height:1;padding:2px 6px;">&times;</button>
  </div>
  <style>
    @keyframes dshPulse {
      0%,100% { box-shadow:0 2px 12px rgba(0,0,0,0.35),0 0 0 0 rgba(63,131,248,0); }
      50%      { box-shadow:0 2px 14px rgba(0,0,0,0.45),0 0 0 6px rgba(63,131,248,0.25); }
    }
    #dsh-update-btn:hover { transform:translateY(-1px); box-shadow:0 4px 18px rgba(63,131,248,0.4); animation:none; }
  </style>`
}

function injectUpdateBanner(newVersion) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const script = `
    (function(){
      if (document.getElementById('dsh-update-banner')) return;
      var host = document.createElement('div');
      host.id = 'dsh-update-host';
      host.innerHTML = ${JSON.stringify(buildUpdateBannerHtml(newVersion))};
      document.body.appendChild(host);
      document.getElementById('dsh-update-btn').addEventListener('click', function(){
        window.dshDesktop && window.dshDesktop.requestUpdate();
      });
      document.getElementById('dsh-update-close').addEventListener('click', function(){
        var h = document.getElementById('dsh-update-host');
        if (h) h.remove();
      });
    })()
  `
  // 页面可能是 SPA，等 body 就绪后再注入，重试；执行后自我确认是否注入成功
  let tries = 0
  const attempt = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.executeJavaScript(`(function(){ return !!document.body })()`)
      .then((hasBody) => {
        if (hasBody) {
          return mainWindow.webContents.executeJavaScript(script).catch((err) => {
            console.log("[dsh-desktop] inject error:", err && err.message);
          }).then(() => 
            mainWindow.webContents.executeJavaScript(`(function(){ return document.getElementById("dsh-update-banner") ? true : false })()`)
          ).then((ok) => console.log("[dsh-desktop] banner present =", ok))
        } else if (tries < 40) {
          tries++
          setTimeout(attempt, 300)
        }
      }).catch((err) => console.log("[dsh-desktop] body check error:", err && err.message))
  }
  attempt()
}

// ---- 设置弹窗内的「版本与更新」设置项 + 插件页「添加插件」按钮注入 ----
// 设置弹窗由编译后的 dsh Web SPA（React）渲染。此处在每次弹窗打开时向真实 DOM
// 注入：① 在「Agent 预设」导航项下方新增一个「版本与更新」导航项及其内容面板
// （LOGO + 当前版本 + 检查更新按钮）；② 在「插件」页标题行右侧注入「添加插件」按钮。
// 通过监听弹窗内部的变化完成注入，RelaX 关闭重开时自动重建。
function buildSettingsEntranceJs() {
  const NAV_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" style="display:block;"><path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.5 1.6v2.7h-2.7"/></svg>'
  const LOGO_SVG =
    '<svg id="dsh-logo" width="80" height="80" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="dshLogoGrad" x1="4" y1="4" x2="92" y2="92" gradientUnits="userSpaceOnUse"><stop stop-color="#3b82f6"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs><rect x="4" y="4" width="88" height="88" rx="24" fill="url(#dshLogoGrad)"/><path d="M28 60c7-18 33-18 44-3 4 5 4 12 0 16-10 9-25 7-35-1-3-2-4-6-4-9 0-1 0-2-1-3z" fill="#fff"/><path d="M68 59c5 0 9 1 11 3 2 2 2 5 0 7" stroke="#0f766e" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M30 70c-3 3-4 7-3 10 5-2 8-4 10-7" fill="#0f766e" opacity=".85"/><circle cx="34" cy="58" r="2.6" fill="#0f766e"/></svg>'
  return `(function(){
    if (window.__dshSettingsEntrance) return;
    window.__dshSettingsEntrance = true;
    var VERSION = ${JSON.stringify(APP_VERSION)};
    var NAV_ICON = ${JSON.stringify(NAV_ICON)};
    var LOGO_SVG = ${JSON.stringify(LOGO_SVG)};

    var currentPanel = null;
    var opts = null;        // 当前弹窗的滚动内容区
    var versionPanel = null;

    function isOurRow(el){ return !!el && el.id === 'dsh-nav-version'; }

    // 找到设置弹窗的滚动内容区（第一个带纵向滚动的 div）
    function findOptions(dialog){
      var divs = dialog.querySelectorAll('div');
      for (var i = 0; i < divs.length; i++){
        var el = divs[i];
        if (el.id === 'dsh-version-panel') continue;
        var cs = getComputedStyle(el);
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return el;
      }
      return null;
    }

    // 选中「版本与更新」：隐藏原生内容，显示我们的面板
    function selectVersion(){
      if (!opts || !versionPanel) return;
      for (var i = 0; i < opts.children.length; i++){
        if (opts.children[i] === versionPanel) continue;
        opts.children[i].style.display = 'none';
      }
      versionPanel.style.display = 'flex';
    }
    // 选中其它导航项：恢复原生内容，隐藏我们的面板
    function selectNative(){
      if (!opts || !versionPanel) return;
      for (var i = 0; i < opts.children.length; i++){
        if (opts.children[i] === versionPanel) continue;
        opts.children[i].style.display = '';
      }
      versionPanel.style.display = 'none';
    }
    // 高亮导航项
    function markActive(row){
      if (!row || !row.parentNode) return;
      var cells = row.parentNode.querySelectorAll('button');
      for (var i = 0; i < cells.length; i++){
        var c = cells[i];
        if (c === row){
          c.style.background = 'var(--dsw-specific-sidebar-nav-item-active, rgba(255,255,255,0.08))';
          if (c.getAttribute('aria-current') !== 'true') c.setAttribute('aria-current', 'true');
        } else {
          c.style.background = '';
          c.removeAttribute('aria-current');
        }
      }
    }

    // 注入导航项 + 版本面板
    function setupVersionNav(dialog, agentBtn){
      var navList = agentBtn.parentNode;
      if (navList && !dialog.querySelector('#dsh-nav-version')){
        var row = document.createElement('button');
        row.type = 'button'; row.id = 'dsh-nav-version';
        row.style.cssText = "box-sizing:border-box;cursor:pointer;height:40px;color:var(--dsw-alias-label-primary, #f2f2f5);text-align:left;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:9px 16px 9px 12px;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;display:flex;";
        row.innerHTML = '<span style="flex:none;display:inline-flex;">' + NAV_ICON + '</span><span style="white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;overflow:hidden;">版本与更新</span>';
        agentBtn.parentNode.insertBefore(row, agentBtn.nextSibling);
        row.addEventListener('click', function(){ selectVersion(); markActive(row); });
        if (!navList.__dshWired){
          navList.__dshWired = true;
          navList.addEventListener('click', function(e){
            var b = e.target && e.target.closest ? e.target.closest('button') : null;
            if (!b || isOurRow(b)) return;
            selectNative(); markActive(b);
          });
        }
      }
      if (!versionPanel && opts){
        versionPanel = document.createElement('div');
        versionPanel.id = 'dsh-version-panel';
        versionPanel.style.cssText = "position:absolute;inset:0;z-index:5;overflow:auto;box-sizing:border-box;display:none;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2, #1e1e22);padding:24px;";
        versionPanel.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;gap:14px;max-width:360px;text-align:center;">' +
            LOGO_SVG +
            '<div style="font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary, #f2f2f5);">DeepSeek Harness</div>' +
            '<div style="font-size:14px;color:var(--dsw-alias-label-secondary, #a1a1ab);">当前版本 <b style="color:var(--dsw-alias-label-primary, #f2f2f5);">v' + VERSION + '</b></div>' +
            '<p style="margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary, #8a8a94);">桌面端封装了 dsh 本地服务，提供后台更新检查与本地 Skill/插件导入。</p>' +
            '<button id="dsh-check-update" style="cursor:pointer;border:none;border-radius:9px;padding:9px 22px;font-size:14px;font-weight:600;color:#fff;background:#3b82f6;box-shadow:0 2px 12px rgba(59,130,246,0.35);transition:transform .15s ease;">检查更新</button>' +
          '</div>';
        opts.style.position = 'relative';
        opts.appendChild(versionPanel);
        document.getElementById('dsh-check-update').addEventListener('click', function(){
          if (window.dshDesktop && window.dshDesktop.checkUpdate) window.dshDesktop.checkUpdate();
        });
      }
    }

    // 注入「添加插件」按钮（插件页标题行右侧）
    function mountPluginsButton(){
      if (!opts) return;
      var els = opts.querySelectorAll('h2');
      var target = null;
      for (var i = 0; i < els.length; i++){
        var t = (els[i].textContent || '').replace(/\\s+/g, ' ').trim();
        if (/插件/.test(t) || /^Plugins$/i.test(t)){ target = els[i]; break; }
      }
      var existing = opts.querySelector('#dsh-add-plugin');
      if (target){
        var sec = target.parentElement;
        if (sec) sec.style.position = 'relative';
        if (!existing){
          var btn = document.createElement('button');
          btn.type = 'button'; btn.id = 'dsh-add-plugin';
          btn.textContent = '添加插件';
          btn.style.cssText = "position:absolute;top:0;right:0;z-index:4;cursor:pointer;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#fff;background:#10b981;box-shadow:0 2px 10px rgba(16,185,129,0.35);";
          if (sec) sec.appendChild(btn);
          btn.addEventListener('click', function(){
            if (window.dshDesktop && window.dshDesktop.importSkill) window.dshDesktop.importSkill();
          });
        }
      } else if (existing){
        existing.remove();
      }
    }

    function observeOptions(){
      if (!opts) return;
      if (opts.__dshObs) return;
      opts.__dshObs = new MutationObserver(mountPluginsButton);
      opts.__dshObs.observe(opts, { childList: true, subtree: true });
      mountPluginsButton();
    }

    function tryMount(){
      var panel = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (panel && panel !== currentPanel){
        currentPanel = panel;
        opts = null; versionPanel = null;
        opts = findOptions(panel);
        var agentBtn = null;
        var btns = panel.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++){
          var t = (btns[i].textContent || '').replace(/\\s+/g, ' ').trim();
          if (/预设/.test(t) || /presets/i.test(t)){ agentBtn = btns[i]; break; }
        }
        if (agentBtn) setupVersionNav(panel, agentBtn);
        observeOptions();
      } else if (!panel && currentPanel){
        currentPanel = null; opts = null; versionPanel = null;
      }
    }
    // 弹窗由 React 动态挂载：轮询 + 观察器双保险，保证任何时机都能检测到设置弹窗
    var bodyObs = new MutationObserver(tryMount);
    try { bodyObs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(tryMount, 400);
  })()`
}

function injectSettingsEntrance() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const script = buildSettingsEntranceJs()
  // did-finish-load 后 body 一定存在，直接注入。脚本自身幂等（__dshSettingsEntrance 守卫）。
  const run = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.executeJavaScript(script)
      .then(() => console.log('[dsh-desktop] settings entrance injected'))
      .catch((err) => console.log('[dsh-desktop] settings entrance inject error:', err && err.message))
  }
  run()
  // 兜底：SPA 可能在加载完成后仍有重渲染/重导航，延迟再注入几次（幂等）
  setTimeout(run, 1200)
  setTimeout(run, 3000)
}

// ---- GitHub 更新检查 ----
async function checkForUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'dsh-desktop', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.log(`[dsh-desktop] update check http ${res.status}`)
      return
    }
    const data = await res.json()
    const latestTag = data?.tag_name
    if (!latestTag) return
    console.log(`[dsh-desktop] remote=${latestTag} local=${APP_VERSION}`)
    if (isNewer(latestTag, APP_VERSION)) {
      injectUpdateBanner(latestTag)
    }
  } catch (error) {
    console.log('[dsh-desktop] update check skipped:', error?.message ?? error)
  }
}

// ---- 更新：下载新版 dmg 到 Downloads 并打开安装镜像 ----
function findDmgAsset(assets) {
  if (!Array.isArray(assets)) return null
  const dmg = assets.find((a) => a.name && a.name.endsWith('.dmg'))
  return dmg ? dmg.browser_download_url : null
}

async function downloadAndInstall(latestTag) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '开始更新',
    message: `正在下载 DeepSeek Harness ${latestTag}...`,
    detail: '下载完成后会自动打开安装镜像，请把 App 拖入「应用程序」覆盖安装完成更新。',
  })
  try {
    const release = await (await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'dsh-desktop', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })).json()
    const url = findDmgAsset(release?.assets)
    if (!url) throw new Error('Release 中未找到 dmg 安装包')
    const dest = path.join(os.homedir(), 'Downloads', `DeepSeek Harness-${latestTag}.dmg`)
    const fileRes = await fetch(url, { redirect: 'follow' })
    if (!fileRes.ok || !fileRes.body) throw new Error(`下载失败 HTTP ${fileRes.status}`)
    const ws = fs.createWriteStream(dest)
    await new Promise((resolve, reject) => {
      fileRes.body.pipe(ws)
      fileRes.body.on('error', reject)
      ws.on('finish', resolve)
      ws.on('error', reject)
    })
    shell.openPath(dest)
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '下载完成',
      message: `新版本 ${latestTag} 已下载完成`,
      detail: `安装镜像：${dest}\n\n打开后请把 DeepSeek Harness.app 拖入「应用程序」以更新。`,
    })
  } catch (error) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '更新失败',
      message: String(error?.message ?? error),
    })
  }
}

// ---- skill 导入 ----
function validateSkillDir(p) {
  return fs.existsSync(path.join(p, 'SKILL.md'))
}
function validateSkillFile(p) {
  return p.toLowerCase().endsWith('.md')
}

async function importSkill() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入本地 Skill',
    buttonLabel: '导入',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Skill 文件', extensions: ['md'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return

  fs.mkdirSync(SKILLS_DIR, { recursive: true })
  const imported = []
  let skipped = 0
  for (const src of result.filePaths) {
    try {
      const stat = fs.statSync(src)
      const base = path.basename(src)
      if (stat.isDirectory() && validateSkillDir(src)) {
        const dest = path.join(SKILLS_DIR, base)
        fs.cpSync(src, dest, { recursive: true, force: true })
        imported.push(base)
      } else if (stat.isFile() && validateSkillFile(src)) {
        fs.copyFileSync(src, path.join(SKILLS_DIR, base))
        imported.push(base)
      } else {
        skipped++
      }
    } catch (error) {
      console.log('[dsh-desktop] importSkill failed for', src, error?.message ?? error)
      skipped++
    }
  }

  if (imported.length > 0) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '导入成功',
      message: `已导入 ${imported.length} 个 Skill`,
      detail: imported.join('、') + '\n\ndsh 会自动检测并加载到技能目录。稍后即可在对话中使用。',
    })
  } else if (skipped > 0) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '未导入有效的 Skill',
      message: '未找到可导入的 Skill 文件',
      detail: '请选择：\n• 含 SKILL.md 的文件夹\n• 以 .md 结尾、带 name/description frontmatter 的 Skill 文件',
    })
  }
}


function installDiagnostics() {
  if (mainWindow) {
    mainWindow.webContents.on('console-message', (e, level, message) => {
      if (/banner|dshDesktop|update/i.test(message)) console.log('[renderer]', message);
    });
  }
}

// ---- 菜单：提供导入 Skill 入口 ----
function installMenu() {
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: '导入本地 Skill...', click: () => importSkill() },
        { type: 'separator' },
        { role: 'quit', label: '退出 DeepSeek Harness' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- 窗口 ----
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#1b1b1f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.loadURL(url)
  installDiagnostics()
  // 页面每次加载完成后再注入一次设置入口（bootstrap 时页面可能尚未加载完成）
  mainWindow.webContents.on('did-finish-load', () => injectSettingsEntrance())

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

async function bootstrap() {
  try {
    console.log('[dsh-desktop] DSH_BIN =', DSH_BIN)
    console.log('[dsh-desktop] starting dsh server...')
    const url = await startServer()
    console.log('[dsh-desktop] server url =', url)
    await waitHttpReady(url)
    console.log('[dsh-desktop] http ready, creating window')
    createWindow(url)

    installMenu()
    checkForUpdate()
    injectSettingsEntrance()
  } catch (error) {
    stopServer()
    dialog.showErrorBox(
      'DeepSeek Harness 启动失败',
      `${error.message ?? error}\n\n请重试；若持续失败可在终端手动运行 npx @deepseek-ai/dsh web 排查。`,
    )
    app.quit()
  }
}

function registerIpc() {
  ipcMain.handle('dsh:request-update', async () => {
    try {
      const res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest', {
        headers: { 'User-Agent': 'dsh-desktop', 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      const release = await res.json();
      await downloadAndInstall(release && release.tag_name ? release.tag_name : '最新版');
    } catch (error) {
      dialog.showMessageBox(mainWindow, { type: 'error', title: '更新失败', message: String(error && error.message ? error.message : error) });
    }
  });
  ipcMain.handle('dsh:import-skill', async () => {
    await importSkill();
  });
  ipcMain.handle('dsh:check-update', async () => {
    await checkUpdate();
  });
}

// ---- 设置里的「检查更新」：对比远端，若更高走下载更新，否则提示已最新 ----
async function checkUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest', {
      headers: { 'User-Agent': 'dsh-desktop', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404 || !res.ok) {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: '已是最新版本', message: '当前已是最新版本（v' + APP_VERSION + '）' })
      return
    }
    const data = await res.json()
    const latest = data && data.tag_name
    if (!latest) {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: '已是最新版本', message: '当前已是最新版本（v' + APP_VERSION + '）' })
      return
    }
    if (isNewer(latest, APP_VERSION)) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: '发现新版本 ' + latest + '，是否更新？',
        detail: '当前版本 v' + APP_VERSION + '\n\n点击「立即更新」将下载新版安装包并打开安装镜像完成更新。',
        buttons: ['立即更新', '取消'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) await downloadAndInstall(latest)
    } else {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: '已是最新版本', message: '当前已是最新版本（v' + APP_VERSION + '）' })
    }
  } catch (error) {
    await dialog.showMessageBox(mainWindow, { type: 'error', title: '检查更新失败', message: String((error && error.message) || error) })
  }
}

app.whenReady().then(async () => { registerIpc(); await bootstrap() })

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', stopServer)
