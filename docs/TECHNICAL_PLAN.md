# VB阅读器技术方案

本方案对应 [产品设计文档](../PRODUCT_DESIGN.md)。Windows 10/11 x64 版已支持 TXT、可重排 EPUB、PDF 的统一书架与阅读；下一阶段第一批增加 TXT 和 EPUB 的选文高亮与文字笔记。应用继续离线运行，不修改或上传原书籍。

## 技术栈结论

**沿用 Electron + TypeScript + Vite + 原生 HTML/CSS、`epubjs` 和 PDF.js。** TXT 正文已有稳定的字符偏移与 CSS 高亮能力；`epubjs` 已提供选文 CFI、标注高亮及点击回调。第一批可在现有阅读模块和本地状态上扩展，笔记编辑使用普通文本输入控件，不需要新增富文本编辑器、数据库或服务端。

| 层次 | 现有实现 | 标注阶段的用法 |
| --- | --- | --- |
| 桌面与构建 | Electron、TypeScript、Vite、esbuild | 保留主进程持久化、预加载脚本受限 API 与阅读界面 |
| TXT 选文与显示 | DOM `Selection`／`Range`、CSS Custom Highlight API | 将选区映射为字符起止偏移；在独立高亮层重绘，不改正文节点 |
| EPUB 选文与显示 | `epubjs` | 获取单章节选文 CFI；用 rendition 标注接口在章节重排后重绘与响应点击 |
| PDF | `pdfjs-dist` | 保持现有阅读功能；PDF 标注不在第一批范围 |
| 本地记录 | `userData` 下版本化 JSON 状态 | 按书籍 ID 保存标注，沿用现有备份与临时文件写入机制 |
| 测试与交付 | Node 测试、Playwright/Electron 窗口测试、electron-builder/NSIS | 验证选文、重排、重启恢复与旧数据迁移 |

实际依赖及脚本见 [package.json](../package.json)。现有格式位置定义见 [共享类型](../src/shared/types.ts)，状态写入见 [状态存储](../src/main/state.ts)，TXT 界面见 [阅读界面](../src/renderer/index.ts)，EPUB 呈现见 [格式阅读模块](../src/renderer/publications.ts)。

## 标注数据与定位

当前书架状态为 `version: 4`，每本书有稳定 `bookId`。新增标注记录按书籍 ID 隔离，包含标注 ID、格式、选文、选文前后少量上下文、可为空的纯文本笔记、创建与修改时间，以及定位状态。TXT 锚点使用选文起止字符偏移；EPUB 锚点使用章节标识与选区 CFI。纯高亮与带笔记使用同一数据结构，笔记可在之后补写或编辑。正文摘录和上下文长度应有明确上限，状态文件不存整本书。

显示标注前先检查锚点处的文字是否仍与保存的选文相符。文件内容变化或锚点无效时，可在原位置附近用选文与前后上下文尝试重新查找；只有唯一且可信的匹配才更新锚点。无法确定时保留笔记和选文，标为“位置待确认”，不在可能错误的文字上画高亮。重新定位书籍路径时标注继续跟随 `bookId`，并重新验证位置。

状态格式升级时兼容现有 `version: 1` 至 `version: 4`，给旧书籍补空标注列表，保留书架、进度、书签和设置。保存标注采用先写入候选状态、成功后再更新内存的方式；笔记写入失败时编辑框保留内容并显示错误，不把失败操作当作已保存。笔记与选文只作为文本显示，避免将书内内容或用户输入解释为 HTML。

## 第一批实施顺序

### 1. 选文与创建

TXT 仅接受完全落在正文内、非空的连续选区，从 `Selection`／`Range` 计算起止偏移。EPUB 监听 `epubjs` 的选文事件，取得同一章节内的 CFI 范围与选文；跨章节选择不创建标注，并给出可理解的提示。普通复制操作保持原行为，选文后出现轻量的“高亮”“写想法”入口。

直接高亮可立即保存；“写想法”先打开含选文预览的纯文本编辑界面，保存成功后才创建标注，取消不写状态。第一批只使用一种高亮颜色。TXT 高亮放在与搜索高亮分开的 CSS Highlight 层，保持原文本节点和进度计算不变；EPUB 使用 `rendition.annotations.highlight`，在章节重新显示后恢复高亮。点击高亮可打开对应笔记：TXT 将点击位置映射回字符偏移，EPUB 使用标注回调。

### 2. 标注管理

当前书籍的标注列表显示选文摘录、笔记和创建时间，并提供跳转、编辑、补写与删除。TXT 跳转到保存的字符范围，EPUB 跳转到选区 CFI；位置待确认的条目仍可查看和编辑笔记，但不执行不可靠的跳转。删除只移除应用记录及屏幕高亮，不修改原书。切换书籍、关闭章节或阅读窗口时清理临时选区与渲染对象，避免标注串书。

### 3. 定位与可靠性

字体、行距、正文宽度、主题、窗口大小或 EPUB 章节变化后，按持久化锚点重绘高亮。TXT 与 EPUB 各自验证选文和上下文；失败时显示“位置待确认”并保留笔记。状态损坏、写入失败、文件丢失以及多次编辑都应给出可见反馈。EPUB 原有的脚本禁用和外部资源限制继续生效，标注不能成为执行书内 HTML 的入口。

## 测试与交付

- **选文与创建**：TXT 与 EPUB 的正常选文、空选区、跨章节 EPUB 选区、纯高亮、带笔记、取消和复制；搜索高亮与标注高亮可同时存在。
- **标注管理**：同书与跨书隔离、列表跳转、补写和修改笔记、删除、点击高亮、关闭重开和重启恢复；确认原书文件未改动。
- **定位与失败**：字号／行距／主题／窗口重排及 EPUB 章节切换后锚点仍对应选文；文件变化后唯一匹配可恢复，歧义或无匹配时保留笔记并显示位置待确认；写入失败不丢失正在编辑的文本。
- **迁移与回归**：旧版状态升级后原书架、进度、书签和设置仍在；TXT／EPUB／PDF 原有导入、阅读、搜索和进度恢复继续通过自动化测试与真实窗口验证。

每项功能完成后运行 `npm run verify`；制作安装包时运行 `npm run dist:win` 并在 Windows 10/11 x64 验证离线安装。PDF 选文标注、OCR、多色高亮和标注导出留待后续版本。

## 参考资料

- [Epub.js 选文与高亮示例](https://github.com/futurepress/epub.js/blob/master/examples/highlights.html)
- [Epub.js 标注 API](https://github.com/futurepress/epub.js/blob/master/documentation/md/API.md)
- [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)
- [DOM Selection.getRangeAt](https://developer.mozilla.org/en-US/docs/Web/API/Selection/getRangeAt)
