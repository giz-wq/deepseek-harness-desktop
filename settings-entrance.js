// DeepSeek Harness Desktop — 设置入口注入模块
// 独立封装：向 dsh Web 设置弹窗注入「存储」「版本与更新」导航项与面板、
// 插件页「添加插件」按钮与「本地已导入 Skill」列表、磁盘扫描弹窗。
// main.js 通过 injectSettingsEntrance(window) 调用。
const APP_VERSION = require('./package.json').version

// ---- 设置弹窗内的「存储」「版本与更新」设置项 + 插件页「添加插件」按钮与 Skill 列表注入 ----
// 设置弹窗由编译后的 dsh Web SPA（React）渲染。此处在每次弹窗打开时向真实 DOM
// 注入：① 在「Agent 预设」导航项下方依次新增「存储」「版本与更新」两个导航项及内容面板
// （存储面板：路径展示 / 清除缓存 / 磁盘空间进度条 / 磁盘扫描弹窗）；② 在「插件」页
// 标题行右侧注入「添加插件」按钮，并在插件页下方展示「本地已导入 Skill」列表
// （导入完成后由 dsh:skills-changed 事件实时刷新）。通过监听弹窗内部的变化完成注入，
// 弹窗关闭重开时自动重建。
function buildSettingsEntranceJs() {
  const NAV_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" style="display:block;"><path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.5 1.6v2.7h-2.7"/></svg>'
  const STORAGE_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" style="display:block;"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2.2"/><path d="M4.8 10.4h1.6"/><path d="M9.2 10.4h2.2"/></svg>'
  const LOGO_SVG =
    '<svg id="dsh-logo" width="80" height="80" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="dshLogoGrad" x1="4" y1="4" x2="92" y2="92" gradientUnits="userSpaceOnUse"><stop stop-color="#3b82f6"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs><rect x="4" y="4" width="88" height="88" rx="24" fill="url(#dshLogoGrad)"/><path d="M28 60c7-18 33-18 44-3 4 5 4 12 0 16-10 9-25 7-35-1-3-2-4-6-4-9 0-1 0-2-1-3z" fill="#fff"/><path d="M68 59c5 0 9 1 11 3 2 2 2 5 0 7" stroke="#0f766e" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M30 70c-3 3-4 7-3 10 5-2 8-4 10-7" fill="#0f766e" opacity=".85"/><circle cx="34" cy="58" r="2.6" fill="#0f766e"/></svg>'
  return `(function(){
    if (window.__dshSettingsEntrance) return;
    window.__dshSettingsEntrance = true;
    var VERSION = ${JSON.stringify(APP_VERSION)};
    var NAV_ICON = ${JSON.stringify(NAV_ICON)};
    var STORAGE_ICON = ${JSON.stringify(STORAGE_ICON)};
    var LOGO_SVG = ${JSON.stringify(LOGO_SVG)};

    var currentPanel = null;
    var opts = null;        // 当前弹窗的滚动内容区
    var versionPanel = null;
    var storagePanel = null;
    var scanModal = null;   // 当前磁盘扫描弹窗

    function isOurRow(el){ return !!el && (el.id === 'dsh-nav-version' || el.id === 'dsh-nav-storage'); }

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

    // 自定义面板切换：隐藏原生内容与其它自定义面板，显示指定面板；panel 为空时恢复原生内容
    function selectPanel(panel){
      if (!opts) return;
      for (var i = 0; i < opts.children.length; i++){
        var c = opts.children[i];
        if (c === versionPanel || c === storagePanel) c.style.display = 'none';
        else c.style.display = '';
      }
      if (panel) panel.style.display = (panel.id === 'dsh-storage-panel') ? 'block' : 'flex';
    }
    function selectVersion(){ selectPanel(versionPanel); }
    function selectStorage(){ selectPanel(storagePanel); renderStorageData(); }
    function selectNative(){ selectPanel(null); }
    // 高亮导航项
    function markActive(row){
      if (!row || !row.parentNode) return;
      var cells = row.parentNode.querySelectorAll('button');
      for (var i = 0; i < cells.length; i++){
        var c = cells[i];
        var active = (c === row);
        if (isOurRow(c)){
          // 注入项没有自己的样式表背景，必须显式指定：选中高亮，未选中透明（用主题一致色）
          c.style.background = active ? 'var(--dsw-specific-sidebar-nav-item-active, rgba(255,255,255,0.08))' : 'var(--dsw-alias-action-fill, transparent)';
        } else {
          c.style.background = active ? 'var(--dsw-specific-sidebar-nav-item-active, rgba(255,255,255,0.08))' : '';
        }
        if (active){ if (c.getAttribute('aria-current') !== 'true') c.setAttribute('aria-current', 'true'); }
        else { c.removeAttribute('aria-current'); }
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

    // ---- 插件页「本地已导入 Skill」列表：导入后由 dsh:skills-changed 事件实时刷新 ----
    function mountSkillsList(){
      if (!opts) return;
      var els = opts.querySelectorAll('h2');
      var target = null;
      for (var i = 0; i < els.length; i++){
        var t = (els[i].textContent || '').replace(/\\s+/g, ' ').trim();
        if (/插件/.test(t) || /^Plugins$/i.test(t)){ target = els[i]; break; }
      }
      if (!target) return;
      var sec = target.parentElement;
      if (!sec) return;
      if (!sec.querySelector('#dsh-skills-section')){
        var wrap = document.createElement('div');
        wrap.id = 'dsh-skills-section';
        wrap.style.cssText = "margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-default, rgba(255,255,255,0.08));";
        wrap.innerHTML =
          '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px;">' +
            '<div style="font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);">本地已导入 Skill</div>' +
            '<span id="dsh-skills-count" style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);"></span>' +
          '</div>' +
          '<div id="dsh-skills-list" style="display:flex;flex-direction:column;gap:8px;">' +
            '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);">读取中…</div>' +
          '</div>';
        sec.appendChild(wrap);
      }
      refreshSkillsList();
    }

    function refreshSkillsList(){
      if (!window.dshDesktop || !window.dshDesktop.skillsList) return;
      window.dshDesktop.skillsList().then(function(list){
        var host = document.getElementById('dsh-skills-list');
        var cnt = document.getElementById('dsh-skills-count');
        if (!host) return;
        host.innerHTML = '';
        if (cnt) cnt.textContent = list.length ? '（' + list.length + '）' : '';
        if (!list || !list.length){
          host.innerHTML = '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);">尚未导入 Skill。点击右上角「添加插件」可导入本地 Skill（含 SKILL.md 的文件夹或 .md 文件）。</div>';
          return;
        }
        for (var i = 0; i < list.length; i++){
          (function(s){
            var row = document.createElement('div');
            row.style.cssText = "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.08));border-radius:10px;padding:10px 12px;";
            var nm = document.createElement('div');
            nm.style.cssText = "font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);";
            nm.textContent = s.name;
            row.appendChild(nm);
            if (s.description){
              var ds = document.createElement('div');
              ds.style.cssText = "font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);margin-top:3px;line-height:1.5;";
              ds.textContent = s.description;
              row.appendChild(ds);
            }
            host.appendChild(row);
          })(list[i]);
        }
      }).catch(function(){ /* 忽略读取失败 */ });
    }

    // ---- 存储面板 ----
    function fmtBytes(n){
      n = Number(n);
      if (!isFinite(n) || n < 0) n = 0;
      var units = ['B', 'KB', 'MB', 'GB', 'TB'];
      var i = 0;
      while (n >= 1024 && i < units.length - 1){ n /= 1024; i++; }
      return (i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
    }

    function buildStoragePanelHtml(){
      return '<div style="max-width:600px;margin:0 auto;display:flex;flex-direction:column;gap:18px;">' +
        '<div style="font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);">存储空间</div>' +
        // 路径卡片
        '<div style="border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,0.08));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:14px;">' +
          '<div>' +
            '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);margin-bottom:5px;">DeepSeek Harness 所在路径</div>' +
            '<div id="dsh-store-install" style="font-size:13px;color:var(--dsw-alias-label-primary,#f2f2f5);font-family:var(--ds-font-family-code,monospace);word-break:break-all;line-height:1.6;">读取中…</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);margin-bottom:5px;">对话缓存路径</div>' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
              '<div id="dsh-store-cache" style="flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary,#f2f2f5);font-family:var(--ds-font-family-code,monospace);word-break:break-all;line-height:1.6;">读取中…</div>' +
              '<button type="button" id="dsh-store-cache-change" style="display:none;flex:none;cursor:pointer;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#fff;background:#3b82f6;box-shadow:0 2px 10px rgba(59,130,246,0.35);">更改</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;justify-content:flex-end;">' +
            '<button type="button" id="dsh-store-clear" style="cursor:pointer;border:none;border-radius:8px;padding:7px 18px;font-size:13px;font-weight:600;color:#fff;background:#ef4444;box-shadow:0 2px 10px rgba(239,68,68,0.35);">清除缓存</button>' +
          '</div>' +
        '</div>' +
        // 磁盘卡片
        '<div style="border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,0.08));border-radius:12px;padding:14px 16px;">' +
          '<div style="font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);margin-bottom:12px;">磁盘空间</div>' +
          '<div id="dsh-store-disks" style="display:flex;flex-direction:column;gap:14px;">' +
            '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);">正在检测磁盘…</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function wireStoragePanel(){
      var clearBtn = document.getElementById('dsh-store-clear');
      if (clearBtn){
        clearBtn.addEventListener('click', function(){
          clearBtn.disabled = true;
          window.dshDesktop.cacheClear().then(function(r){
            clearBtn.disabled = false;
            if (r && r.error) alert(r.error);
          }).catch(function(){ clearBtn.disabled = false; });
        });
      }
      var chgBtn = document.getElementById('dsh-store-cache-change');
      if (chgBtn){
        chgBtn.addEventListener('click', function(){
          chgBtn.disabled = true;
          window.dshDesktop.cacheChange().then(function(r){
            chgBtn.disabled = false;
            if (r && r.error) alert(r.error);
          }).catch(function(){ chgBtn.disabled = false; });
        });
      }
    }

    function renderStorageData(){
      if (!storagePanel || !storagePanel.isConnected) return;
      if (window.dshDesktop && window.dshDesktop.storageInfo){
        window.dshDesktop.storageInfo().then(function(info){
          var el1 = document.getElementById('dsh-store-install');
          var el2 = document.getElementById('dsh-store-cache');
          var chg = document.getElementById('dsh-store-cache-change');
          if (el1 && info.installPath) el1.textContent = info.installPath;
          if (el2 && info.cachePath) el2.textContent = info.cachePath;
          // 更改缓存路径仅 Windows 提供
          if (chg) chg.style.display = info.isWindows ? '' : 'none';
        }).catch(function(){ /* 忽略 */ });
      }
      if (window.dshDesktop && window.dshDesktop.disksList){
        window.dshDesktop.disksList().then(renderDisks).catch(function(){
          var host = document.getElementById('dsh-store-disks');
          if (host) host.innerHTML = '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);">磁盘信息读取失败</div>';
        });
      }
    }

    function renderDisks(disks){
      var host = document.getElementById('dsh-store-disks');
      if (!host) return;
      host.innerHTML = '';
      if (!disks || !disks.length){
        host.innerHTML = '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);">未检测到磁盘信息</div>';
        return;
      }
      for (var i = 0; i < disks.length; i++){
        (function(d){
          var total = d.total || 0;
          var free = d.free || 0;
          var used = Math.max(0, total - free);
          var pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
          var insufficient = free < 5 * 1024 * 1024 * 1024 || (total > 0 && free / total < 0.05);
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;flex-direction:column;gap:7px;';
          var head = document.createElement('div');
          head.style.cssText = 'display:flex;align-items:center;gap:10px;';
          var nameEl = document.createElement('div');
          nameEl.style.cssText = 'flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#f2f2f5);';
          nameEl.textContent = d.name;
          head.appendChild(nameEl);
          if (insufficient){
            var warn = document.createElement('span');
            warn.style.cssText = 'flex:none;font-size:11px;color:#f87171;font-weight:600;';
            warn.textContent = '磁盘空间不足';
            head.appendChild(warn);
          }
          var scanBtn = document.createElement('button');
          scanBtn.type = 'button';
          scanBtn.textContent = '扫描';
          scanBtn.style.cssText = 'flex:none;cursor:pointer;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,0.12));border-radius:7px;padding:4px 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);background:transparent;';
          scanBtn.addEventListener('click', function(){ openScanModal(d); });
          head.appendChild(scanBtn);
          row.appendChild(head);
          var track = document.createElement('div');
          track.style.cssText = 'height:8px;border-radius:99px;background:rgba(255,255,255,0.12);overflow:hidden;';
          var fill = document.createElement('div');
          fill.style.cssText = 'height:100%;border-radius:99px;transition:width .25s ease;';
          fill.style.width = pct + '%';
          fill.style.background = insufficient ? '#ef4444' : 'linear-gradient(90deg,#3b82f6,#10b981)';
          track.appendChild(fill);
          row.appendChild(track);
          var cap = document.createElement('div');
          cap.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a94);';
          cap.textContent = '已用 ' + fmtBytes(used) + ' / 共 ' + fmtBytes(total) + '，剩余 ' + fmtBytes(free);
          row.appendChild(cap);
          host.appendChild(row);
        })(disks[i]);
      }
    }

    // ---- 磁盘扫描弹窗 ----
    function ensureScanStyle(){
      if (document.getElementById('dsh-scan-style')) return;
      var st = document.createElement('style');
      st.id = 'dsh-scan-style';
      st.textContent = '@keyframes dshScanSpin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }

    function closeScanModal(){
      if (scanModal){ scanModal.remove(); scanModal = null; }
    }

    function scanBoxShell(){
      var box = document.createElement('div');
      box.style.cssText = 'width:min(860px,88vw);height:min(640px,82vh);display:flex;flex-direction:column;border-radius:16px;background:var(--dsw-alias-bg-layer-2,#1e1e22);border:1px solid rgba(255,255,255,0.1);box-shadow:0 24px 70px rgba(0,0,0,0.55);overflow:hidden;';
      return box;
    }

    function openScanModal(d){
      closeScanModal();
      ensureScanStyle();
      scanModal = document.createElement('div');
      scanModal.id = 'dsh-scan-modal';
      scanModal.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
      var box = scanBoxShell();
      scanModal.appendChild(box);
      scanModal.addEventListener('click', function(e){ if (e.target === scanModal) closeScanModal(); });
      document.body.appendChild(scanModal);
      renderScanLoading(box, d);
      if (window.dshDesktop && window.dshDesktop.diskScan){
        window.dshDesktop.diskScan(d.mount).then(function(res){
          if (scanModal && scanModal.isConnected) renderScanResult(box, d, res);
        }).catch(function(err){
          if (scanModal && scanModal.isConnected) renderScanError(box, err);
        });
      }
    }

    function renderScanLoading(box, d){
      box.innerHTML =
        '<div style="padding:24px 30px 6px;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);">正在扫描 ' + d.name + '</div>' +
        '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:30px;">' +
          '<div style="width:44px;height:44px;border-radius:50%;border:3px solid rgba(59,130,246,0.25);border-top-color:#3b82f6;animation:dshScanSpin 1s linear infinite;"></div>' +
          '<div style="font-size:15px;color:var(--dsw-alias-label-primary,#f2f2f5);font-weight:500;">正在加急扫描磁盘，请耐心等待</div>' +
          '<div id="dsh-scan-progress" style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);">准备扫描…</div>' +
        '</div>' +
        '<div style="padding:12px 30px 20px;display:flex;justify-content:flex-end;">' +
          '<button type="button" id="dsh-scan-close" style="cursor:pointer;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,0.12));border-radius:8px;padding:7px 18px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#a1a1ab);background:transparent;">关闭</button>' +
        '</div>';
      var btn = document.getElementById('dsh-scan-close');
      if (btn) btn.addEventListener('click', closeScanModal);
    }

    function renderScanError(box, err){
      box.innerHTML =
        '<div style="padding:24px 30px 6px;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);">扫描失败</div>' +
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:30px;">' +
          '<div style="font-size:13px;color:var(--dsw-alias-state-error-primary,#f87171);line-height:1.6;">' + String((err && err.message) || err) + '</div>' +
        '</div>' +
        '<div style="padding:12px 30px 20px;display:flex;justify-content:flex-end;">' +
          '<button type="button" id="dsh-scan-close" style="cursor:pointer;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,0.12));border-radius:8px;padding:7px 18px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#a1a1ab);background:transparent;">关闭</button>' +
        '</div>';
      var btn = document.getElementById('dsh-scan-close');
      if (btn) btn.addEventListener('click', closeScanModal);
    }

    function renderScanResult(box, d, res){
      var suggestions = [];
      if (res.cacheBytes > 0) suggestions.push({ label: '缓存文件', size: res.cacheBytes, tip: '建议清理应用产生的 Cache/Caches 缓存目录。' });
      if (res.logBytes > 0) suggestions.push({ label: '日志文件', size: res.logBytes, tip: '建议删除不再需要的 .log 日志文件。' });
      if (res.tmpBytes > 0) suggestions.push({ label: '临时文件', size: res.tmpBytes, tip: '建议清理系统与应用的临时文件。' });
      if (res.nodeModulesBytes > 0) suggestions.push({ label: '项目依赖 (node_modules)', size: res.nodeModulesBytes, tip: '建议对不再维护的项目删除 node_modules，需要时重装即可。' });
      var recoverable = (res.cacheBytes || 0) + (res.logBytes || 0) + (res.tmpBytes || 0) + (res.nodeModulesBytes || 0);
      var topFiles = res.topFiles || [];
      var listHtml = '';
      for (var i = 0; i < Math.min(topFiles.length, 20); i++){
        listHtml +=
          '<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;background:rgba(255,255,255,0.03);">' +
            '<span style="flex:none;width:22px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a94);text-align:right;">' + (i + 1) + '</span>' +
            '<span style="flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#a1a1ab);font-family:var(--ds-font-family-code,monospace);word-break:break-all;line-height:1.5;" title="' + topFiles[i].path.replace(/"/g, '&quot;') + '">' + topFiles[i].path + '</span>' +
            '<span style="flex:none;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);">' + fmtBytes(topFiles[i].size) + '</span>' +
          '</div>';
      }
      if (!listHtml) listHtml = '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);padding:8px 2px;">未发现可统计的大文件。</div>';
      var sugHtml = '';
      for (var j = 0; j < suggestions.length; j++){
        sugHtml +=
          '<div style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;background:rgba(255,255,255,0.03);">' +
            '<span style="flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary,#f2f2f5);">' + suggestions[j].label +
              '<span style="display:block;margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a94);">' + suggestions[j].tip + '</span>' +
            '</span>' +
            '<span style="flex:none;font-size:12px;font-weight:600;color:var(--dsw-alias-state-business-primary,#3b82f6);">' + fmtBytes(suggestions[j].size) + '</span>' +
          '</div>';
      }
      if (!sugHtml) sugHtml = '<div style="font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);padding:8px 2px;">未发现明显可清理项。</div>';
      box.innerHTML =
        '<div style="padding:24px 30px 10px;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);">' + d.name + ' 扫描结果</div>' +
        '<div style="padding:0 30px 14px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);">共扫描 ' + res.files + ' 个文件，总计 ' + fmtBytes(res.bytes) + '。此次清理完成后预计可回收 <b style="color:#10b981;">' + fmtBytes(recoverable) + '</b> 存储空间。</div>' +
        '<div style="flex:1;min-height:0;overflow:auto;padding:0 30px 20px;display:flex;flex-direction:column;gap:18px;">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);margin-bottom:8px;">清理建议</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' + sugHtml + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f5);margin-bottom:8px;">大文件占用排行</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;">' + listHtml + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="padding:12px 30px 20px;display:flex;justify-content:flex-end;">' +
          '<button type="button" id="dsh-scan-close" style="cursor:pointer;border:none;border-radius:8px;padding:7px 20px;font-size:13px;font-weight:600;color:#fff;background:#3b82f6;">关闭</button>' +
        '</div>';
      var btn = document.getElementById('dsh-scan-close');
      if (btn) btn.addEventListener('click', closeScanModal);
    }

    function observeOptions(){
      if (!opts) return;
      if (opts.__dshObs) return;
      opts.__dshObs = new MutationObserver(function(){
        mountPluginsButton();
        mountSkillsList();
      });
      opts.__dshObs.observe(opts, { childList: true, subtree: true });
      mountPluginsButton();
      mountSkillsList();
    }

    function tryMount(){
      var panel = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (panel && panel !== currentPanel){
        currentPanel = panel;
        opts = null; versionPanel = null; storagePanel = null;
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
        currentPanel = null; opts = null; versionPanel = null; storagePanel = null;
      }
    }

    // 注入导航项 + 版本面板 + 存储面板（顺序：存储在前，版本与更新在后）
    function setupVersionNav(dialog, agentBtn){
      var navList = agentBtn.parentNode;
      // 存储导航项：紧插在「Agent 预设」下方
      if (navList && !dialog.querySelector('#dsh-nav-storage')){
        var srow = document.createElement('button');
        srow.type = 'button'; srow.id = 'dsh-nav-storage';
        srow.style.cssText = "box-sizing:border-box;cursor:pointer;height:40px;color:var(--dsw-alias-label-primary, #f2f2f5);text-align:left;background:transparent;border:none;border-radius:12px;align-items:center;gap:8px;padding:9px 16px 9px 12px;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;display:flex;";
        srow.innerHTML = '<span style="flex:none;display:inline-flex;">' + STORAGE_ICON + '</span><span style="white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;overflow:hidden;">存储</span>';
        agentBtn.parentNode.insertBefore(srow, agentBtn.nextSibling);
        srow.addEventListener('click', function(){ selectStorage(); markActive(srow); });
      }
      // 版本与更新导航项：插在「存储」下方
      if (navList && !dialog.querySelector('#dsh-nav-version')){
        var anchor = dialog.querySelector('#dsh-nav-storage') || agentBtn;
        var row = document.createElement('button');
        row.type = 'button'; row.id = 'dsh-nav-version';
        row.style.cssText = "box-sizing:border-box;cursor:pointer;height:40px;color:var(--dsw-alias-label-primary, #f2f2f5);text-align:left;background:transparent;border:none;border-radius:12px;align-items:center;gap:8px;padding:9px 16px 9px 12px;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;display:flex;";
        row.innerHTML = '<span style="flex:none;display:inline-flex;">' + NAV_ICON + '</span><span style="white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;overflow:hidden;">版本与更新</span>';
        anchor.parentNode.insertBefore(row, anchor.nextSibling);
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
      // 存储面板
      if (!storagePanel && opts){
        storagePanel = document.createElement('div');
        storagePanel.id = 'dsh-storage-panel';
        storagePanel.style.cssText = "position:absolute;inset:0;z-index:5;overflow:auto;box-sizing:border-box;display:none;background:var(--dsw-alias-bg-layer-2, #1e1e22);padding:24px;";
        storagePanel.innerHTML = buildStoragePanelHtml();
        opts.style.position = 'relative';
        opts.appendChild(storagePanel);
        wireStoragePanel();
      }
    }
    // 弹窗由 React 动态挂载：轮询 + 观察器双保险，保证任何时机都能检测到设置弹窗
    var bodyObs = new MutationObserver(tryMount);
    try { bodyObs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(tryMount, 400);
    // Skill 导入完成后实时刷新插件页的本地 Skill 列表（只注册一次）
    if (window.dshDesktop && window.dshDesktop.onSkillsChanged && !window.__dshSkillsWired){
      window.__dshSkillsWired = true;
      window.dshDesktop.onSkillsChanged(function(){ refreshSkillsList(); });
    }
    // 磁盘扫描进度：更新扫描弹窗中的进度行（只注册一次）
    if (window.dshDesktop && window.dshDesktop.onDiskScanProgress && !window.__dshScanProgWired){
      window.__dshScanProgWired = true;
      window.dshDesktop.onDiskScanProgress(function(p){
        var el = document.getElementById('dsh-scan-progress');
        if (el && p) el.textContent = '已扫描 ' + p.files + ' 个文件 · ' + fmtBytes(p.bytes);
      });
    }
  })()`
}

function injectSettingsEntrance(mainWindow) {
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

module.exports = { buildSettingsEntranceJs, injectSettingsEntrance }
