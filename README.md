# 喵喵翻译

Windows 优先的本地桌面翻译工具。使用 OpenAI Chat Completions 兼容接口翻译文本和常见 Office 文档，API 密钥与设置保存在本机。

产品显示名称和 Windows 可执行文件名为“喵喵翻译”；内部 `appId` `com.translatormeow.app` 及 Electron 用户数据目录保持不变，因此升级后原有接口、模型、语言和密钥设置仍可继续使用。

## 环境要求

- Windows 10/11（开发构建也可在其他平台运行，但发布包以 Windows 为准）
- Node.js 20、22 或 24，以及 npm 10 以上
- 可访问的 OpenAI Chat Completions 兼容接口

## 开发

```bash
npm ci
npm run dev
```

提交前检查：

```bash
npm run check
npm run audit:prod
```

Windows 未安装版与 NSIS 安装包：

```bash
npm run build
npm run verify:package
npm run package:win
```

`npm run build` 生成 Windows 未安装版，默认输出目录为 `release/win-unpacked`；`npm run package:win` 生成 NSIS 安装包。若未安装版目录被旧程序占用，可使用带版本号的输出目录（例如 `release/win-unpacked-v4`）进行验证，并通过 `npm run verify:package -- release/win-unpacked-v4` 检查指定目录。

## 能力

- 直接文本翻译，接口失败自动重试两次，可取消。
- 提供“自动检测 → 简体中文”“简体中文 → English”“English → 简体中文”三种快捷翻译方向；源语言和目标语言仍可手动编辑。选择会保存在原有设置文件中，并同时用于直接文本与文档翻译。
- DOCX、PPTX、XLSX：仅替换 OOXML 文本节点，ZIP 包内其他部分保持不变。
- 数字文本 PDF：保留原始 PDF 页面内容，在推断出的文本行区域覆盖白底译文，并仍输出 `.pdf`；扫描版 PDF 会明确拒绝，需先 OCR。
- 接口地址、模型和语言设置保存在 Electron 用户数据目录；API 密钥使用 Electron `safeStorage`（Windows 上为 DPAPI）加密后单独保存。渲染进程只能看到 `apiKeyConfigured` 状态，不能读取密钥原值，所有网络请求均由主进程发出。
- 仅接受 HTTP/HTTPS 接口地址；单次请求有 60 秒超时，可由用户取消。
- 文档输出使用临时文件和备份回滚，任务失败时不会删除已有输出，也不允许输出覆盖原始文档。

## 隐私与安全

翻译内容会发送到你配置的第三方接口服务商。应用本身不提供云端代理，也不会把 API 密钥交给渲染页面。请在使用前了解服务商的数据保留和隐私政策，不要翻译不应离开本机或组织网络的敏感文件。

发现安全问题时请不要直接发布包含密钥、个人文件或可利用细节的公开 Issue；参见 [SECURITY.md](SECURITY.md)。

## PDF 字体策略

应用不捆绑第三方字体，以避免额外安装体积和许可文件遗漏。生成 PDF 时会按顺序寻找系统已安装的黑体、微软雅黑、Noto Sans CJK 或苹方，并尝试将字体子集嵌入结果。Windows 11 默认具备黑体和微软雅黑；若候选字体不存在或当前字体解析器不支持，应用会继续尝试下一项，最终无可用字体时给出明确错误，不会生成缺字 PDF。

## 限制

- Office 文档会把同一逻辑段落或字符串单元中的文本节点合并后翻译，再将译文分配回原有节点；复杂格式仍可能产生不自然断句或运行级格式偏差。
- 不翻译图片、文本框以外的嵌入对象、批注图形或扫描件。
- PDF 是可信的“尽力保真”方案而非专业排版：原页面图形与背景保持不变，译文按提取到的文本行定位覆盖；多栏、旋转文字、透明背景、复杂公式、密集表格或译文显著变长时可能出现白底遮挡、缩字或局部重叠。
- PDF 不执行 OCR；数字文本过少会按扫描版拒绝。
- `safeStorage` 不可用时拒绝保存新密钥，不会回退到明文。
- 单个文档上限为 100 MB，目标 OOXML 内容另有限额；单次直接翻译上限为 100,000 个字符。

## 参与开发

问题报告和代码贡献请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目采用 [MIT License](LICENSE)。
