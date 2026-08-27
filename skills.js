// DeepSeek Harness Desktop — Skill 导入模块
// 独立封装：从本地文件系统导入 Skill 到 ~/.dsh/skills，导入成功后通知渲染进程刷新列表。
// main.js 通过 importSkill() 调用。
const { dialog, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

function validateSkillDir(p) {
  return fs.existsSync(path.join(p, 'SKILL.md'))
}
function validateSkillFile(p) {
  return p.toLowerCase().endsWith('.md')
}

// deps: { getWindow, skillsDir }；返回是否导入了至少一个 Skill
async function importSkill({ getWindow, skillsDir }) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return false
  const result = await dialog.showOpenDialog(win, {
    title: '导入本地 Skill',
    buttonLabel: '导入',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Skill 文件', extensions: ['md'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return false

  fs.mkdirSync(skillsDir, { recursive: true })
  const imported = []
  let skipped = 0
  for (const src of result.filePaths) {
    try {
      const stat = fs.statSync(src)
      const base = path.basename(src)
      if (stat.isDirectory() && validateSkillDir(src)) {
        const dest = path.join(skillsDir, base)
        fs.cpSync(src, dest, { recursive: true, force: true })
        imported.push(base)
      } else if (stat.isFile() && validateSkillFile(src)) {
        fs.copyFileSync(src, path.join(skillsDir, base))
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
    dialog.showMessageBox(win, {
      type: 'info',
      title: '导入成功',
      message: `已导入 ${imported.length} 个 Skill`,
      detail: imported.join('、') + '\n\ndsh 会自动检测并加载到技能目录。稍后即可在对话中使用。',
    })
    // 通知渲染进程立即刷新插件页的「本地已导入 Skill」列表
    const w = getWindow()
    if (w && !w.isDestroyed()) {
      w.webContents.send('dsh:skills-changed')
    }
    return true
  } else if (skipped > 0) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '未导入有效的 Skill',
      message: '未找到可导入的 Skill 文件',
      detail: '请选择：\n• 含 SKILL.md 的文件夹\n• 以 .md 结尾、带 name/description frontmatter 的 Skill 文件',
    })
  }
  return false
}

function registerSkillsIpc(deps) {
  ipcMain.handle('dsh:import-skill', async () => {
    await importSkill(deps)
  })
}

module.exports = { importSkill, registerSkillsIpc }
