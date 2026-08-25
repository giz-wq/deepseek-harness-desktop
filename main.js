// DeepSeek Harness Desktop — Electron 主进程
// 后台拉起 `dsh web` 本地服务，解析实际端口后在 BrowserWindow 中加载 Web UI。
const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')

// dsh CLI 入口（npm 包 @deepseek-ai/dsh 的 bin）
const DSH_BIN = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const STARTUP_TIMEOUT_MS = 90_000
const URL_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:(\d+))/

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
  // 用 Electron 自带的 Node 运行时执行 dsh CLI；detached 让子进程成为
  // 新进程组组长，退出时可用 kill(-pid) 整组回收（含 dsh 派生的子进程）。
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
        resolve(match[1]) // http://127.0.0.1:PORT
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
    // 杀整个进程组，回收 dsh 派生的子进程（语言服务、沙箱等）
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
    },
  })

  mainWindow.loadURL(url)

  // 页内新窗口/外链交给系统浏览器
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
  } catch (error) {
    stopServer()
    dialog.showErrorBox(
      'DeepSeek Harness 启动失败',
      `${error.message ?? error}\n\n请重试；若持续失败可在终端手动运行 npx @deepseek-ai/dsh web 排查。`,
    )
    app.quit()
  }
}

app.whenReady().then(bootstrap)

app.on('window-all-closed', () => {
  // macOS 惯例是驻留，但本应用窗口即全部 UI，直接退出并回收后台服务
  app.quit()
})

app.on('before-quit', stopServer)
