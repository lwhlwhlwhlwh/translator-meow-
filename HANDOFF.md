# 喵喵翻译（Translator Meow）项目交接

> 本文只记录当前脱敏工作区中可由源代码、配置、测试和脚本确认的事实。路径均使用项目内相对路径或泛化后的运行时位置，不包含个人目录、密钥或其他私有标识。

## 1. 项目定位与当前产品名

- 产品用途：Windows 优先的本地 Electron 桌面翻译工具，支持直接文本翻译和文档翻译。
- 当前产品显示名：**喵喵翻译**。
- npm 包名：`translator-meow`；当前版本：`0.1.0`。
- Electron `appId`：`com.translatormeow.app`。该标识与显示名分开，不能在不考虑升级兼容性的情况下随意变更。
- 许可证：MIT（见 `LICENSE`）。
- UI 语言和产品说明当前以中文为主；快捷翻译方向包含中文与 English。

## 2. 已实现能力、格式与明确限制

### 直接翻译

- 通过任意兼容 OpenAI Chat Completions 请求格式的服务商翻译文本。
- 快捷方向：`自动检测 → 简体中文`、`简体中文 → English`、`English → 简体中文`。
- 源语言和目标语言仍可手动编辑，并持久化到设置。
- 请求可取消；接口错误和限流会给出中文状态提示。

### Office 文档

- 支持 `.docx`、`.pptx`、`.xlsx`。
- 以 ZIP/OOXML 方式读取包，只处理指定 XML 部件中的文本节点：
  - DOCX：正文、页眉、页脚、脚注、尾注、批注 XML。
  - PPTX：幻灯片和备注页 XML。
  - XLSX：共享字符串和工作表 XML。
- 替换文本节点时保留 ZIP 中未处理的文件；输出先写入同目录临时文件，既有输出会先重命名为临时备份，新文件就位后再删除备份。失败时尽力恢复旧输出。
- XLSX 含公式的单元格不会被翻译，避免改写公式。
- 文本会按段落、幻灯片段落、共享字符串/内联字符串等逻辑单元合并后翻译，再把结果分配回原有文本节点。

### PDF

- 支持有可提取数字文本的 `.pdf`。
- 保留原始 PDF 页面，再在推断出的文本行区域绘制白色覆盖矩形和译文；输出仍为 PDF。
- 会尝试从系统字体中寻找可嵌入的 CJK 字体（Windows 黑体/微软雅黑，以及 Linux/macOS 候选字体），并使用子集嵌入。
- 不执行 OCR；扫描版或可提取文本过少的 PDF 会拒绝处理。
- PDF 是“尽力保真”覆盖方案，不是重新排版器。多栏、旋转文字、透明背景、复杂公式、密集表格、背景图以及显著变长的译文可能产生遮挡、缩字或重叠。
- 不翻译图片、文本框以外的嵌入对象、图形批注或扫描图像。

### 通用限制

- Office 文档中的多个文本节点按逻辑单元翻译，但复杂格式可能出现不自然断句；原有文本运行的格式并不等同于完整的版式重排。
- 若所有有效文本单元都与原文基本相同，不生成新输出，并保留同名旧输出；若只有部分有效单元未变化，会通过进度事件发出警告。
- 输入和输出不能是同一路径；Office 输出扩展名必须与输入一致。文档上限为 100 MB，目标 OOXML 解压文本另有 25,000,000 字符限制。
- 单次文本翻译上限为 100,000 字符；每次接口请求有 60 秒超时。
- `safeStorage` 不可用时拒绝保存新 API 密钥，不回退为明文保存。
- 应用依赖服务商完成真正翻译，不包含本地翻译模型。

## 3. 架构与进程边界

### 进程边界

1. **渲染进程**（`src/renderer/`）负责中文 UI、文本/文件选择交互、进度展示和设置表单。
2. **预加载层**（`src/preload/index.ts`）通过 `contextBridge` 暴露受限的 `window.app` API；不把 Node 能力直接暴露给页面。
3. **主进程**（`src/main/index.ts`）负责 Electron 窗口、文件对话框、设置读取、密钥读取、IPC 处理和发起网络请求。
4. **共享翻译层**（`src/shared/translation.ts`）负责端点拼接、请求体、响应解析、错误处理、重试和限流闸门。
5. **文档管线**（`src/main/documents.ts`）负责 OOXML/PDF 解析、翻译单元调度、结果重建、进度和临时文件写出。

窗口启用了 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`。所有网络请求由主进程发出，渲染进程只能通过预加载 API 请求操作。

### 关键文件

- `package.json`：脚本、依赖、产品名和入口。
- `src/main/index.ts`：主进程、IPC、设置和密钥生命周期。
- `src/preload/index.ts`：安全的渲染进程 API 面。
- `src/shared/types.ts`：设置、请求、进度和 API 类型。
- `src/shared/translation.ts`：OpenAI 兼容接口、响应形状、重试/429 处理。
- `src/main/documents.ts`：DOCX/PPTX/XLSX/PDF 处理算法。
- `src/renderer/App.tsx`、`src/renderer/styles.css`：当前 UI。
- `scripts/build-electron.mjs`：主进程和预加载 bundle 构建。
- `scripts/verify-package.mjs`：Windows 未安装包完整性检查。
- `electron-builder.yml`：Windows NSIS 打包配置。
- `test/core.test.ts`：共享翻译、响应解析、限流和文本节点单元测试。
- `test/documents.integration.test.ts`：三种 OOXML 格式的接口模拟集成测试。

## 4. 设置、API 密钥与运行时用户数据

- Electron 运行时用户数据目录由 `app.getPath('userData')` 决定；本文不固化具体个人路径。
- 普通设置文件：该目录下的 `settings.json`，保存接口地址、模型、源语言、目标语言和并发数。
- 密钥文件：同一目录下的 `api-key.bin`，由 Electron `safeStorage.encryptString` 加密保存。Windows 上的保护依赖系统 DPAPI/安全存储能力。
- 兼容迁移：如果旧设置 JSON 中存在 `apiKey` 字段且系统安全存储可用，启动读取时会迁移到加密密钥文件，并重写普通设置文件移除旧字段。
- `getSettings()` 只向渲染进程返回 `apiKeyConfigured: boolean`，不返回密钥原值。翻译时主进程重新读取密钥并构造运行时设置。
- 保存设置会将并发数限制在 1–6；默认并发为 2。默认接口为 `https://api.openai.com/v1`，默认模型为 `gpt-4o-mini`，默认源语言为自动检测，目标语言为简体中文。
- 清除密钥使用加密空字符串写回，清除操作是尽力而为；代码不会把密钥回退写入明文。
- `.gitignore` 明确忽略 `settings.json` 和 `api-key.bin`；不要把运行时用户数据复制进仓库或发布包。

## 5. OpenAI-compatible endpoint 行为与响应形状

### 请求端点

- 用户设置的基础地址去除末尾 `/`。
- 如果基础地址已经以 `/chat/completions` 结尾，则直接使用；否则追加 `/chat/completions`。
- 请求方法为 `POST`，请求头为 `Content-Type: application/json`；存在密钥时增加 `Authorization: Bearer <key>`。
- 请求体形状：

```json
{
  "model": "<configured model>",
  "temperature": 0.1,
  "messages": [
    {"role": "system", "content": "...translator instructions..."},
    {"role": "user", "content": "<source text>"}
  ]
}
```

系统提示要求保留格式、占位符、数字、名称和换行，并只返回译文。应用不声明或发送流式请求参数。

### 接受的成功响应

`extractTranslationText()` 按以下顺序寻找第一个非空文本：

1. `choices[0].message.content` 为字符串。
2. `choices[0].message.content` 为数组，其中元素为字符串或含 `text` 字符串的对象；数组元素会拼接。
3. `choices[0].text`。
4. 顶层 `output_text`。
5. 顶层 `output` 数组中各项的 `content`，同样支持字符串或含 `text` 的数组。

成功文本会 `trim()`。不符合这些形状时抛出可诊断错误，并列出响应顶层字段。

### 失败、重试和取消

- HTTP 400/401/403 会转换为带针对性提示的请求错误，不进行服务器重试。
- 其他非 429 HTTP 错误最多进行 3 次服务器尝试，间隔约为 500 ms、1 s；仍失败则报错。
- HTTP 429 最多进行 5 次限流尝试。优先读取 `Retry-After` 的秒数或日期，等待时间上限 60 s；没有有效值时使用带随机扰动的指数等待，上限 15 s。
- 文档的并发请求共享一个限流闸门，使同一文档翻译在冷却期内避免重试风暴；等待可被取消。
- 请求、等待和文档工作队列均响应 `AbortSignal`。主进程的新翻译任务会先取消旧的活动任务。

## 6. 文档处理算法

### OOXML

1. 按输入扩展名选择目标 XML 路径和文本标签正则。
2. 用 JSZip 解包内存中的 OOXML ZIP，提取目标部件。
3. 以逻辑段落/字符串单元提取所有文本节点，XML 实体先解码。
4. 过滤空白单元；XLSX 含 `<f>` 的公式单元不翻译。
5. 按配置并发数启动 worker，给每个逻辑单元调用共享翻译函数；结果按源索引写回数组，因此响应先后不会改变文档顺序。
6. 把译文重新分配到原有文本节点，尽量保留开头/结尾空白；重新压缩 ZIP，通过同目录临时文件和旧输出备份完成可回滚替换。

### PDF

1. 使用 `pdfjs-dist` 读取每页文本内容和变换矩阵。
2. 按 y 坐标和字符高度阈值把同一行的文本 item 合并为 `PdfTextBlock`，按页面从上到下、同一行从左到右排序。
3. 用去除空白后的字符数阈值判断是否存在足够的数字文本。
4. 使用 `pdf-lib` 加载原始 PDF，注册 `fontkit`，从系统候选字体中选择可嵌入 CJK 字体。
5. 并发翻译每个文本块；根据可用宽度拆行、缩小字号，并绘制半透明白色矩形覆盖原文后绘制译文。
6. 先把新 PDF 写入同目录临时文件，通过旧输出备份完成可回滚替换；全部有效单元回显时保留旧输出并失败，部分回显则发出警告。

## 7. 并发与速率限制

- UI 设置把文档并发限制为 1–6，默认 2；文档管线再次强制限制到 1–6，并且不超过实际翻译单元数。
- 文本直接翻译是单请求；文档翻译使用固定数量 worker 消费共享索引。
- 进度事件在每个单元完成时报告 `current`、`total` 和消息；请求限流时也会发送等待提示。
- worker 失败会中止内部控制器并使其他 worker 停止；输出不会在翻译完成前替换。
- 429 冷却由共享 gate 管理，其他请求等待同一冷却窗口；成功探测请求可恢复 gate。

## 8. 命令、前置条件与构建

### 前置条件

- Node.js 20、22 或 24；Electron 主进程 bundle 的 esbuild target 为 `node20`。
- npm，以及 Windows 打包所需的 Electron/electron-builder 依赖；依赖版本由 `package-lock.json` 锁定。
- Windows PDF 翻译需要系统中存在可嵌入的候选 CJK 字体之一。
- 运行时需要可访问用户配置的 OpenAI 兼容接口和有效模型/密钥（若服务商要求密钥）。

### 开发和检查

```bash
npm install
npm run dev
npm test
npm run typecheck
```

`npm run dev` 同时启动 Vite 和等待 Vite 就绪的 Electron 开发窗口。

### 干净构建

```bash
npm ci
npm run typecheck
npm test
npm run build:renderer
npm run build:electron
```

其中 renderer 输出到 `dist/`，Electron 主进程和预加载 bundle 输出到 `dist-electron/`。

### Windows 未安装版验证

```bash
npm run build
npm run verify:package
```

`npm run build` 会构建 renderer、Electron bundle，然后执行 `electron-builder --win --dir`，默认输出到 `release/win-unpacked`。如果旧程序占用目录，可把 electron-builder 输出改到带版本号的目录，再将该目录传给：

```bash
npm run verify:package -- release/win-unpacked-vN
```

验证脚本检查 Windows 可执行文件、ASAR 中的关键入口、没有意外打入 runtime `node_modules`、没有 Linux 产物，并在 Windows 主机上执行可执行文件加载探针。

### Windows 安装包

```bash
npm run package:win
```

该命令使用 `electron-builder --win` 和 `electron-builder.yml` 的 NSIS 配置，输出到 `release/`。当前 NSIS 配置为非一键安装，并允许用户选择安装目录。

## 9. 测试覆盖与验证状态

当前测试文件覆盖：

- 产品名、appId、快捷语言方向和 UI 调用路径。
- `/chat/completions` URL 拼接。
- 多种 OpenAI 风格成功响应形状和错误响应诊断。
- 有意义的原文回显检测、同语言 false positive 排除。
- `Retry-After`、共享限流 gate、取消和永久 429 错误提示。
- XML 实体编解码、DOCX/PPTX/XLSX 文本提取/替换、跨文本节点长度变化、边界空白和公式保护。
- PDF 文本行推断。
- DOCX、PPTX、XLSX 的模拟 HTTP 服务集成测试：并发上限、顺序、进度、延迟收益、备用响应形状、ZIP 未处理文件保留、全回显拒绝和部分回显警告。

### 必须区分的两个状态

- **最近一次已验证的构建状态**：在清理生成依赖和发布产物之前，项目曾完成过 Windows 构建/打包验证流程；该历史状态不能被当作当前工作区已经重新构建的证明。
- **当前源码验证状态**：已重新执行类型检查、44 项测试、renderer 构建、Electron bundle 构建和 Electron 39.8.10 运行探针并通过。当前本机使用 Node 24.16.0，electron-builder 26.15.7 的 `--win --dir` 在 CLI 初始化后无输出挂起；已排除 Electron ZIP 损坏和工作区 Unicode 路径因素。Windows 未安装包和安装包应由固定 Node 22 的 GitHub Actions CI 重新构建验证。

## 10. 隐私、发布状态与忽略文件

- 当前工作区是准备交接的脱敏源代码状态，不应视为已发布的 GitHub 仓库或正式发行版。
- 生成的 release 已刻意移除，后续必须从源代码重新构建；不要恢复或提交旧二进制作为源码发布物。
- API 密钥、用户设置和日志不应进入仓库；接口调用会把用户输入发送到用户配置的第三方服务商，这是产品使用时需要向用户说明的隐私边界。

`.gitignore` 有意排除：

- 依赖：`node_modules/`。
- 构建/打包：`dist/`、`dist-electron/`、`release*/`。
- 环境文件：`.env`、`.env.*`，但保留 `.env.example`。
- 日志：`*.log`、`logs/`、npm/yarn/pnpm 调试日志。
- 覆盖率和缓存：`coverage/`、`.nyc_output/`、`.cache/`、`.parcel-cache/`、`.vite/`、`.vitest/`、`*.tsbuildinfo`。
- 临时文件：`tmp/`、`temp/`、`*.tmp`、`*.temp`。
- 运行时秘密/设置：`settings.json`、`api-key.bin`。
- 编辑器和操作系统文件：`.idea/`、`.vscode/`、交换文件、备份文件、`.DS_Store`、`Thumbs.db`。

## 11. 已知风险与技术债

1. OOXML 处理依赖正则定位 XML 结构，不是完整 XML DOM/命名空间解析器；遇到非常规序列化、跨部件关系或复杂标记时需要增加 fixture 和更稳健的解析策略。
2. Office 文本按逻辑单元翻译，文本运行之间的字体、语言、换行和复杂格式可能与更长/更短译文不完全匹配。
3. PDF 覆盖方案不理解完整版面语义，尤其不适合多栏、旋转、透明和复杂表格内容。
4. 系统字体发现依赖固定候选路径和运行主机字体；跨机器、跨语言 Windows 安装仍需实机验证。
5. OpenAI 兼容性是有意的有限子集：不支持流式响应、工具调用、批量接口或需要额外认证头的服务商；响应解析虽兼容几种常见形状，但不是通用协议适配层。
6. 429 gate 是单次文档/翻译队列内共享的内存状态，不是跨应用实例或跨用户的全局限流器。
7. API 地址由用户配置，当前代码没有建立服务商 allowlist；需要评估 SSRF、恶意端点和企业网络策略后再扩大使用场景。
8. 当前已有 Windows GitHub Actions CI、Dependabot、贡献指南和安全策略；自动创建 GitHub Release、代码签名和发布审批仍未建立。
9. 当前源码检查已重新验证，但本地 Electron 二进制下载受网络超时影响，Windows 未安装包与安装包应以 CI 的干净构建结果为准。

## 12. 建议后续任务（优先级顺序）

1. **P0：完成 Windows 包验证**。执行 `npm run build` 和 `npm run verify:package`，记录 Windows、Node、Electron 和构建产物版本。
2. **P0：建立 Git 仓库和秘密扫描门禁**。按下方 Codex checklist 初始化、扫描、首次提交；确认未追踪文件和历史中没有密钥/个人路径。
3. **P1：验证 CI**。推送后确认 Windows workflow 的安装、类型检查、测试、构建、包验证和制品上传全部通过。
4. **P1：增加真实格式回归 fixture**。覆盖带命名空间变体、复杂文本运行、表格、批注、备注页、公式和 Unicode/XML 边界的 DOCX/PPTX/XLSX。
5. **P1：增加 PDF 金样测试和人工验收清单**。覆盖多栏、旋转、字体缺失、超长译文、图文混排，并明确何时推荐 OCR/专业排版工具。
6. **P2：审查 endpoint 安全策略**。考虑 URL 校验、代理配置、超时、证书/企业代理、最大输入大小和服务商隐私提示。
7. **P2：完善可观测性和恢复体验**。增加结构化、脱敏日志；细化网络超时、部分失败、磁盘空间和取消后的状态。
8. **P2：评估 XML 解析技术债**。若支持范围扩大，替换脆弱的正则编辑方式或至少建立更全面的包级 round-trip 测试。

## 13. 给 Codex 的精确 GitHub 交接 checklist

以下步骤必须按顺序执行；**只有用户明确提供远程 URL 后，才允许添加 remote**。

1. 在项目根目录初始化仓库：

   ```bash
   git init
   ```

2. 先检查状态和忽略规则：

   ```bash
   git status --short --ignored
   git check-ignore -v settings.json api-key.bin dist dist-electron release
   ```

3. 检查源码、配置、测试和脚本，确认当前显示名是“喵喵翻译”，并确认生成 release 已被刻意移除、需要重建。

4. 在暂存前后做秘密扫描。至少检查 API key 常见模式、`.env`、运行时设置、个人绝对路径和生成二进制；可使用本地工具如 `gitleaks` 或等效扫描器。发现疑似秘密时停止，不要提交。

5. 检查最终 diff 和文件清单：

   ```bash
   git add .editorconfig .gitattributes .github .gitignore CONTRIBUTING.md HANDOFF.md LICENSE README.md SECURITY.md electron-builder.yml index.html package.json package-lock.json scripts src test tsconfig.json tsconfig.node.json vite.config.ts
   git diff --cached --check
   git status --short
   ```

   如果 README 没有变化，不要强行修改或添加无关文件。

6. 创建首次提交（提交信息可采用以下准确表达）：

   ```bash
   git commit -m "Prepare 喵喵翻译 source handoff"
   ```

7. 再次检查提交和工作区：

   ```bash
   git status --short
   git log -1 --stat
   ```

8. **仅在用户提供 GitHub URL 后**添加远程仓库，并核对 URL：

   ```bash
   git remote add origin <USER_PROVIDED_GITHUB_URL>
   git remote -v
   ```

9. 推送前再次运行秘密扫描和 `git status`；确认用户要求的默认分支后再推送：

   ```bash
   git branch -M main
   git push -u origin main
   ```

10. 可选发布流程：不要把 release 二进制提交到源码仓库。先在 CI 中完成 Windows 干净构建、测试、`verify:package` 和制品留存，再由 CI 创建 GitHub Release 并上传 CI 产物。发布前应由用户确认版本号、release notes、可见性和上传策略。
