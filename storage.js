// DeepSeek Harness Desktop — 存储管理模块
// 独立封装：本地 Skill 列表 / 对话缓存路径 / 磁盘空间枚举 / 全盘扫描 / 清除与更改缓存。
// main.js 通过 registerStorageIpc() 一行接入。
const { dialog, app, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// dsh 主目录：优先 DSH_HOME 环境变量，默认 ~/.dsh
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(os.homedir(), '.dsh')
// web profile 的用户补丁层：覆盖 session-persistence-jsonl 的 root 即可改缓存路径
const PROFILE_PATCH_FILE = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')

// 对话缓存路径：优先读取 profile 补丁中 session-persistence-jsonl 的 root 覆盖
function getSessionCachePath() {
  try {
    const raw = fs.readFileSync(PROFILE_PATCH_FILE, 'utf8')
    const m = raw.match(/root:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m)
    if (m && m[1].trim()) return path.resolve(m[1].trim())
  } catch { /* 未配置补丁，走默认路径 */ }
  return path.join(DSH_HOME, 'sessions')
}

function parseFrontmatterField(raw, field) {
  const m = raw.match(new RegExp('^' + field + ':\\s*(.+)$', 'm'))
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null
}

// 扫描 skills 目录，解析每个 Skill 的 name/description 供插件页展示
function listLocalSkills(skillsDir) {
  const skills = []
  let entries
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }) } catch { return skills }
  for (const entry of entries) {
    try {
      let mdPath = null
      if (entry.isDirectory()) mdPath = path.join(skillsDir, entry.name, 'SKILL.md')
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) mdPath = path.join(skillsDir, entry.name)
      if (!mdPath || !fs.existsSync(mdPath)) continue
      const raw = fs.readFileSync(mdPath, 'utf8').slice(0, 4096)
      skills.push({
        name: parseFrontmatterField(raw, 'name') || entry.name,
        description: parseFrontmatterField(raw, 'description') || '',
        file: entry.name,
      })
    } catch { /* 跳过无法解析的条目 */ }
  }
  return skills
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))))
  })
}

// 枚举本机所有磁盘的容量与剩余空间（Windows 走 PowerShell，其余走 df -k）
async function listDisks() {
  if (process.platform === 'win32') {
    const out = await runCommand('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress",
    ])
    let data = JSON.parse(out)
    if (!Array.isArray(data)) data = [data]
    return data
      .filter((d) => d.DeviceID && d.Size)
      .map((d) => ({
        name: d.DeviceID,
        mount: d.DeviceID + '\\',
        total: Number(d.Size) || 0,
        free: Number(d.FreeSpace) || 0,
      }))
  }
  const out = await runCommand('df', ['-k'])
  const disks = []
  const seenDevices = new Set()
  for (const line of out.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const fsDev = parts[0]
    const totalKb = Number(parts[1])
    const availKb = Number(parts[3])
    const mount = parts[parts.length - 1]
    if (!fsDev.startsWith('/dev/')) continue
    if (!(mount === '/' || mount.startsWith('/Volumes/'))) continue
    // 同一块物理盘的多个 APFS 卷去重（/ 与 /System/Volumes/Data 等）
    const base = fsDev.match(/^\/dev\/(disk\d+|sd[a-z]+|nvme\d+n\d+)/)
    const key = base ? base[1] : fsDev
    if (seenDevices.has(key)) continue
    seenDevices.add(key)
    disks.push({
      name: mount === '/' ? '系统磁盘' : mount.replace(/^\/Volumes\//, ''),
      mount,
      total: totalKb * 1024,
      free: availKb * 1024,
    })
  }
  return disks
}

// 全盘扫描：统计占用、缓存/日志/临时文件/依赖体积，并保留最大的 50 个文件
let diskScanRunning = false
async function scanDiskRoot(mount, sendProgress) {
  if (diskScanRunning) throw new Error('已有磁盘扫描正在进行，请稍后再试')
  diskScanRunning = true
  try {
    const topFiles = []
    let files = 0
    let bytes = 0
    let cacheBytes = 0
    let logBytes = 0
    let tmpBytes = 0
    let nodeModulesBytes = 0
    let lastEmit = 0
    // 挂载根下跳过的系统目录（虚拟设备 / 系统元数据）
    const rootSkip = new Set(['dev', 'proc', 'sys', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100', '.TemporaryItems', '.Trashes'])

    async function walk(dir) {
      let dirents
      try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const full = path.join(dir, dirent.name)
        if (dirent.isDirectory()) {
          if (dir === mount && rootSkip.has(dirent.name)) continue
          await walk(full)
          continue
        }
        if (!dirent.isFile()) continue
        let st
        try { st = await fs.promises.stat(full) } catch { continue }
        files++
        bytes += st.size
        const lower = full.toLowerCase()
        if (lower.endsWith('.log')) logBytes += st.size
        if (lower.endsWith('.tmp') || lower.endsWith('.temp') || /[\/\\]tmp[\/\\]/.test(lower)) tmpBytes += st.size
        if (/[\/\\](cache|caches)[\/\\]/.test(lower)) cacheBytes += st.size
        if (lower.includes('node_modules')) nodeModulesBytes += st.size
        if (topFiles.length < 80) {
          topFiles.push({ path: full, size: st.size })
        } else {
          let minIdx = 0
          for (let i = 1; i < topFiles.length; i++) {
            if (topFiles[i].size < topFiles[minIdx].size) minIdx = i
          }
          if (st.size > topFiles[minIdx].size) topFiles[minIdx] = { path: full, size: st.size }
        }
        if (files - lastEmit >= 2000) {
          lastEmit = files
          try { sendProgress({ files, bytes }) } catch { /* 渲染进程可能已销毁 */ }
        }
      }
    }
    await walk(mount)
    topFiles.sort((a, b) => b.size - a.size)
    return {
      files,
      bytes,
      cacheBytes,
      logBytes,
      tmpBytes,
      nodeModulesBytes,
      topFiles: topFiles.slice(0, 50),
    }
  } finally {
    diskScanRunning = false
  }
}

// 清除全部对话缓存：确认弹窗 → 停服务 → 删除 sessions 目录 → 重启服务
async function clearConversationCache(getWindow, restartServer) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口不可用' }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '清除对话缓存',
    message: '您确定要清除您的所有对话缓存吗？',
    detail: '清除后所有历史对话记录将被删除，且无法恢复。',
    buttons: ['取消', '确定'],
    defaultId: 1,
    cancelId: 0,
  })
  if (response !== 1) return { ok: false, canceled: true }
  const cachePath = getSessionCachePath()
  try {
    await restartServer({ stopOnly: true })
    fs.rmSync(cachePath, { recursive: true, force: true })
    fs.mkdirSync(cachePath, { recursive: true })
  } catch (error) {
    return { ok: false, error: `清除失败：${error?.message ?? error}` }
  }
  await restartServer()
  return { ok: true }
}

// 更改对话缓存路径（仅 Windows）：选择目录 → 写 profile 补丁覆盖 sessions root → 重启服务
async function changeCacheDir(getWindow, restartServer) {
  if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 支持更改对话缓存路径' }
  const win = getWindow()
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口不可用' }
  const result = await dialog.showOpenDialog(win, {
    title: '选择对话缓存目录',
    buttonLabel: '选择',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
  const target = path.join(result.filePaths[0], 'sessions')
  let raw = ''
  try { raw = fs.readFileSync(PROFILE_PATCH_FILE, 'utf8') } catch { /* 补丁文件可能不存在 */ }
  const trimmed = raw.trim()
  // 仅在补丁文件为空或空数组时安全写入，避免覆盖用户自定义补丁
  if (trimmed !== '' && trimmed !== '[]') {
    return {
      ok: false,
      error: `检测到自定义 profile 补丁，为避免覆盖请手动编辑后重启：\n${PROFILE_PATCH_FILE}`,
    }
  }
  try {
    fs.mkdirSync(path.dirname(PROFILE_PATCH_FILE), { recursive: true })
    fs.writeFileSync(PROFILE_PATCH_FILE, `- id: session-persistence-jsonl\n  config:\n    root: '${target.replace(/'/g, "''")}'\n`)
  } catch (error) {
    return { ok: false, error: `写入配置失败：${error?.message ?? error}` }
  }
  await restartServer()
  return { ok: true, path: target }
}

// 注册存储管理全部 IPC；deps: { getWindow, restartServer, skillsDir }
function registerStorageIpc({ getWindow, restartServer, skillsDir }) {
  ipcMain.handle('dsh:skills-list', () => listLocalSkills(skillsDir))
  ipcMain.handle('dsh:storage-info', () => ({
    installPath: app.getAppPath(),
    cachePath: getSessionCachePath(),
    skillsPath: skillsDir,
    isWindows: process.platform === 'win32',
  }))
  ipcMain.handle('dsh:disks-list', () => listDisks())
  ipcMain.handle('dsh:disk-scan', async (event, mount) => {
    if (typeof mount !== 'string' || !mount.trim()) throw new Error('无效的扫描目标')
    return scanDiskRoot(mount, (p) => {
      try { event.sender.send('dsh:disk-scan-progress', p) } catch { /* 渲染进程可能已销毁 */ }
    })
  })
  ipcMain.handle('dsh:cache-clear', () => clearConversationCache(getWindow, restartServer))
  ipcMain.handle('dsh:cache-change', () => changeCacheDir(getWindow, restartServer))
}

module.exports = { registerStorageIpc, getSessionCachePath, listLocalSkills, listDisks }
