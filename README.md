# DeepSeek Harness Desktop（桌面端）

> **二创声明（重点强调）**：本项目是对 DeepSeek 官方的开源项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT 开源协议）进行的**二次创作**桌面端封装。
>
> ⚠️ **必须明确：本仓库纯属个人娱乐爱好的技术学习作品，不涉及任何商业性用途，不具备任何商业价值，也不用于任何营利用途。** 本项目**仅做二次创作**，无意替代、资助或商业化官方项目，无意利用 DeepSeek 品牌牟利。
>
> 如 DeepSeek 官方或原作者认为本项目有任何不妥，欢迎联系我，我会立即下架相关内容。此声明对仓库内所有内容（含源码与发布产出的安装包）均有效。

## 项目简介

DeepSeek Harness（`dsh`）官方目前只有 Web 端。本项目将其封装为一个 macOS 桌面应用：

- 后台自动拉起 `dsh web` 本地服务（动态端口，不占用固定端口）
- 用 Electron 原生窗口加载 Web UI，提供桌面端的访问体验
- 退出应用时自动回收后台服务进程

## 工作原理

```
启动 App → 拉起 dsh web 服务（--no-open --port 0 动态端口）
        → 解析 stdout 的 "dsh web: http://127.0.0.1:PORT"
        → Electron 原生窗口加载该 URL
退出 App → 回收后台服务进程组（含 dsh 派生的子进程）
```

## 目录结构

```
dsh-desktop/
├── main.js          # Electron 主进程（拉服务 + 解析端口 + 加载窗口）
├── package.json     # 依赖与打包配置
├── build/           # 应用图标等打包资源
└── icon-src.jpg     # 图标源图
```

## 环境要求

- macOS (Apple Silicon)
- Node.js ≥ 22
- npm

## 开发运行

```bash
npm install
npm start        # 开发模式启动（electron .）
```

## 打包

```bash
npm run dist     # 生成 macOS .app / .dmg / .zip
```

产物在 `dist/` 目录下。

## 安装

1. 打开生成的 `DeepSeek Harness-*.dmg`
2. 把 `DeepSeek Harness.app` 拖入「应用程序」文件夹
3. 首次打开若提示"无法验证开发者"：右键 → 打开 → 再点「打开」

## License

本项目采用 **MIT License**（与上游 `deepseek-ai/deepseek-harness` 一致）。

> 非商业二创声明：上游 dsh 核心逻辑版权归 DeepSeek 团队所有。本项目仅做桌面端封装这一二次创作，纯属个人娱乐爱好的技术学习，不涉及任何商业性用途。若 DeepSeek 官方或原作者认为有任何不妥，可随时联系我下架。
