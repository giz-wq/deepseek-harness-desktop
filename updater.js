// DeepSeek Harness Desktop — 更新检查模块
// 独立封装：GitHub Release 检查、页面顶部更新横幅注入、下载 dmg 并打开安装镜像。
// main.js 通过 registerUpdateIpc() 一行接入。
const { dialog, shell, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

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

function injectUpdateBanner(win, newVersion) {
  if (!win || win.isDestroyed()) return
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
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`(function(){ return !!document.body })()`)
      .then((hasBody) => {
        if (hasBody) {
          return win.webContents.executeJavaScript(script).catch((err) => {
            console.log("[dsh-desktop] inject error:", err && err.message);
          }).then(() =>
            win.webContents.executeJavaScript(`(function(){ return document.getElementById("dsh-update-banner") ? true : false })()`)
          ).then((ok) => console.log("[dsh-desktop] banner present =", ok))
        } else if (tries < 40) {
          tries++
          setTimeout(attempt, 300)
        }
      }).catch((err) => console.log("[dsh-desktop] body check error:", err && err.message))
  }
  attempt()
}

// ---- GitHub 更新检查 ----
async function checkForUpdate({ getWindow, githubRepo, appVersion }) {
  try {
    const res = await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
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
    console.log(`[dsh-desktop] remote=${latestTag} local=${appVersion}`)
    if (isNewer(latestTag, appVersion)) {
      injectUpdateBanner(getWindow(), latestTag)
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

async function downloadAndInstall({ getWindow, githubRepo, latestTag }) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  dialog.showMessageBox(win, {
    type: 'info',
    title: '开始更新',
    message: `正在下载 DeepSeek Harness ${latestTag}...`,
    detail: '下载完成后会自动打开安装镜像，请把 App 拖入「应用程序」覆盖安装完成更新。',
  })
  try {
    const release = await (await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
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
    dialog.showMessageBox(win, {
      type: 'info',
      title: '下载完成',
      message: `新版本 ${latestTag} 已下载完成`,
      detail: `安装镜像：${dest}\n\n打开后请把 DeepSeek Harness.app 拖入「应用程序」以更新。`,
    })
  } catch (error) {
    dialog.showMessageBox(win, {
      type: 'error',
      title: '更新失败',
      message: String(error?.message ?? error),
    })
  }
}

// ---- 设置里的「检查更新」：对比远端，若更高走下载更新，否则提示已最新 ----
async function checkUpdate({ getWindow, githubRepo, appVersion }) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    const res = await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
      headers: { 'User-Agent': 'dsh-desktop', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404 || !res.ok) {
      await dialog.showMessageBox(win, { type: 'info', title: '已是最新版本', message: '当前已是最新版本（v' + appVersion + '）' })
      return
    }
    const data = await res.json()
    const latest = data && data.tag_name
    if (!latest) {
      await dialog.showMessageBox(win, { type: 'info', title: '已是最新版本', message: '当前已是最新版本（v' + appVersion + '）' })
      return
    }
    if (isNewer(latest, appVersion)) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: '发现新版本',
        message: '发现新版本 ' + latest + '，是否更新？',
        detail: '当前版本 v' + appVersion + '\n\n点击「立即更新」将下载新版安装包并打开安装镜像完成更新。',
        buttons: ['立即更新', '取消'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) await downloadAndInstall({ getWindow, githubRepo, latestTag: latest })
    } else {
      await dialog.showMessageBox(win, { type: 'info', title: '已是最新版本', message: '当前已是最新版本（v' + appVersion + '）' })
    }
  } catch (error) {
    await dialog.showMessageBox(win, { type: 'error', title: '检查更新失败', message: String((error && error.message) || error) })
  }
}

// 注册更新相关 IPC；deps: { getWindow, githubRepo, appVersion }
function registerUpdateIpc(deps) {
  ipcMain.handle('dsh:request-update', async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${deps.githubRepo}/releases/latest`, {
        headers: { 'User-Agent': 'dsh-desktop', 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      })
      const release = await res.json()
      await downloadAndInstall({ ...deps, latestTag: release && release.tag_name ? release.tag_name : '最新版' })
    } catch (error) {
      dialog.showMessageBox(deps.getWindow(), { type: 'error', title: '更新失败', message: String(error && error.message ? error.message : error) })
    }
  })
  ipcMain.handle('dsh:check-update', async () => {
    await checkUpdate(deps)
  })
}

module.exports = { registerUpdateIpc, checkForUpdate, checkUpdate, isNewer }
