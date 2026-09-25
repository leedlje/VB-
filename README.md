# TXT 阅读器

Windows 10/11 x64 的离线 TXT 阅读器。支持 UTF-8 和手动切换 GB18030、字号调整、逐文件阅读进度及启动时恢复上次文件。正文不会写入应用状态文件。

## 使用

运行安装包后点击“打开 TXT”选择本地文件。出现乱码时在顶部“编码”菜单选择 GB18030。滚动位置自动保存；下次启动会尝试打开上次阅读的文件。

## 开发与交付

需要 Node.js 22.12+、npm 和 Windows x64。

```powershell
npm ci
npm run dev
npm run verify
npm run dist:win
```

`npm run verify` 运行 TypeScript 类型检查、单元测试、文档测试、构建和真实 Electron 窗口测试。`npm run dist:win` 在 `release/` 生成 NSIS 安装包。首次构建需从 Electron 官方发布源下载运行文件；安装后的阅读器不需要网络。

阅读状态保存在 Electron 的 `userData/reader-state/state.json`。文件缺失、空文件、无法读取及状态损坏会显示提示或恢复默认状态。首版仅支持整文件读取的 TXT，不包含目录、搜索或其他电子书格式。
