# VB阅读器

Windows 10/11 x64 的离线本地阅读器，支持 TXT、可重排 EPUB 和 PDF。书架引用原文件路径；应用不会上传、移动或改写书籍正文。

## 使用

点击“导入书籍”可一次选择多个 TXT、EPUB、PDF。书架显示标题、作者、格式、封面或默认图及阅读进度，并可按最近阅读或书名排序、按格式筛选和搜索书名。再次导入同一路径会使用现有记录。“移出书架”只删除应用记录；文件移动后可点“重新定位”保留进度与书签。

- TXT：保留换行，支持 UTF-8 与手动切换 GB18030；滚动后保存字符位置。
- EPUB：显示目录、图片和书内链接；可翻页、搜索、加书签，使用 CFI 恢复位置。固定版式和加密／DRM EPUB 会显示原因。
- PDF：按页阅读，可输入页码、翻页、缩放、适合页面或宽度；支持书签及有文字层 PDF 的搜索。扫描图片可阅读，但不提供 OCR。

明亮、深色、护眼主题适用于所有格式；字号和行距只影响 TXT 与 EPUB。重启后会尝试打开上次阅读的书。快捷键：`Ctrl+O` 打开 TXT，`Ctrl+F` 搜索，`F3`／`Shift+F3` 跳转结果，`Esc` 关闭面板。

## 开发与交付

需要 Node.js 22.12+、npm 和 Windows x64。

```powershell
npm ci
npm run dev
npm run verify
npm run dist:win
```

`npm run verify` 包含 TypeScript 检查、单元测试、文档测试、构建和真实 Electron 窗口测试。`npm run dist:win` 在 `release/` 生成 NSIS 安装包。安装后的阅读器无需网络。

状态文件位于旧版沿用的 `%APPDATA%/local-txt-reader/reader-state/state.json`。首次升级时自动迁移 v1、v2、v3 的 TXT 记录、书签和外观设置，并保留原状态备份。封面缓存单独存放，状态文件不包含书籍正文或 PDF 页面。安装标识继续沿用旧版，以便覆盖升级。

产品目标见 [产品设计](PRODUCT_DESIGN.md)，实现边界见 [技术方案](docs/TECHNICAL_PLAN.md)。
