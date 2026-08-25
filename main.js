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

// ---- 设置弹窗内的「版本与更新」条形（挂在 body 上，设置弹窗打开时吸附其下方显示）----
function buildVersionBarJs() {
  return `(function(){
    if (window.__dshVersionBar) return;
    var VERSION = "VERSION_PLACEHOLDER";
    var bar = document.createElement('div');
    bar.id = 'dsh-version-bar';
    bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);z-index:2147483001;display:none;align-items:center;gap:14px;padding:10px 18px;border-radius:12px;background:rgba(31,31,34,0.96);border:1px solid rgba(255,255,255,0.10);box-shadow:0 8px 26px rgba(0,0,0,0.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#ededf0;";
    bar.innerHTML =
      '<span style="font-size:13px;white-space:nowrap;">版本 <b style="color:#fff;">v' + VERSION + '</b></span>' +
      '<button id="dsh-ver-check" style="cursor:pointer;border:none;border-radius:7px;padding:6px 14px;font-size:12px;font-weight:600;color:#fff;background:#3b82f6;box-shadow:0 2px 10px rgba(59,130,246,0.35);transition:transform .15s ease;">检查更新</button>' +
      '<button id="dsh-import-skill" style="cursor:pointer;border:none;border-radius:7px;padding:6px 14px;font-size:12px;font-weight:600;color:#fff;background:#10b981;box-shadow:0 2px 10px rgba(16,185,129,0.35);transition:transform .15s ease;">导入插件</button>';
    document.body.appendChild(bar);
    document.getElementById('dsh-ver-check').addEventListener('click', function(){
      if (window.dshDesktop && window.dshDesktop.checkUpdate) window.dshDesktop.checkUpdate();
    });
    document.getElementById('dsh-import-skill').addEventListener('click', function(){
      if (window.dshDesktop && window.dshDesktop.importSkill) window.dshDesktop.importSkill();
    });
    function place(){
      var dlg = document.querySelector('[role="dialog"][aria-modal="true"], [data-modals-root] [role="dialog"], [class*="modal"] [class*="visible"]');
      if (!dlg) { bar.style.display = 'none'; return; }
      var r = dlg.getBoundingClientRect();
      var vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh) { bar.style.display = 'none'; return; }
      var top = r.bottom + 12;
      if (top + bar.offsetHeight + 16 > vh) top = Math.max(12, r.top - bar.offsetHeight - 12);
      bar.style.top = top + 'px';
      bar.style.display = 'flex';
    }
    var mo = new MutationObserver(place);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', place);
    window.__dshVersionBar = true;
    setTimeout(place, 500);
  })()`
}

function injectVersionBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const script = buildVersionBarJs().replace('"VERSION_PLACEHOLDER"', JSON.stringify(APP_VERSION))
  let tries = 0
  const attempt = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.executeJavaScript(`(function(){ return !!document.body })`)
      .then((hasBody) => {
        if (hasBody) {
          mainWindow.webContents.executeJavaScript(script).catch((err) =>
            console.log('[dsh-desktop] version bar inject error:', err && err.message))
        } else if (tries < 40) {
          tries++
          setTimeout(attempt, 300)
        }
      })
      .catch(() => { if (tries < 40) { tries++; setTimeout(attempt, 300) } })
  }
  attempt()
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
    injectVersionBar()
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
