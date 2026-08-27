// DeepSeek Harness Desktop — Electron 主进程
// 后台拉起 `dsh web` 本地服务，解析实际端口后在 BrowserWindow 中加载 Web UI。
// 各功能已独立封装为模块，由本文件统一装配调用：
//   skills.js           — 本地 Skill 导入
//   storage.js          — 存储管理（Skill 列表 / 磁盘空间 / 磁盘扫描 / 对话缓存）
//   updater.js          — GitHub 更新检查与下载
//   settings-entrance.js— 设置弹窗「存储」「版本与更新」等注入
const { app, BrowserWindow, shell, Menu } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

// 功能模块
const { registerSkillsIpc } = require('./skills')
const { registerStorageIpc } = require('./storage')
const { registerUpdateIpc, checkForUpdate } = require('./updater')
const { injectSettingsEntrance } = require('./settings-entrance')

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

// 重启 dsh 服务并让窗口加载新地址（改缓存路径 / 清缓存后由 storage 模块调用）
async function restartServer(options) {
  if (options && options.stopOnly) {
    stopServer()
    return
  }
  stopServer()
  const url = await startServer()
  await waitHttpReady(url)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url)
}

function installDiagnostics() {
  if (mainWindow) {
    mainWindow.webContents.on('console-message', (e, level, message) => {
      if (/banner|dshDesktop|update|error|Error|undefined|Cannot/i.test(message)) console.log('[renderer]', message);
    });
  }
}

// ---- 菜单：提供导入 Skill 入口 ----
function installMenu() {
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: '导入本地 Skill...', click: () => require('./skills').importSkill({ getWindow: () => mainWindow, skillsDir: SKILLS_DIR }) },
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
  mainWindow.webContents.on('did-finish-load', () => injectSettingsEntrance(mainWindow))

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
    checkForUpdate({ getWindow: () => mainWindow, githubRepo: GITHUB_REPO, appVersion: APP_VERSION })
    injectSettingsEntrance(mainWindow)
  } catch (error) {
    stopServer()
    const { dialog } = require('electron')
    dialog.showErrorBox(
      'DeepSeek Harness 启动失败',
      `${error.message ?? error}\n\n请重试；若持续失败可在终端手动运行 npx @deepseek-ai/dsh web 排查。`,
    )
    app.quit()
  }
}

function registerIpc() {
  const deps = { getWindow: () => mainWindow, githubRepo: GITHUB_REPO, appVersion: APP_VERSION }
  registerSkillsIpc({ ...deps, skillsDir: SKILLS_DIR })
  registerStorageIpc({ getWindow: deps.getWindow, restartServer, skillsDir: SKILLS_DIR })
  registerUpdateIpc(deps)
}

app.whenReady().then(async () => {
  registerIpc(); await bootstrap()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', stopServer)
