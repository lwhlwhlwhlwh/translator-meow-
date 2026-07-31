# 参与贡献

感谢你帮助改进喵喵翻译。提交代码前，请先搜索现有 Issue，避免重复工作。较大的功能或格式支持变更建议先开 Issue 说明目标、边界和测试方案。

## 开发环境

项目支持 Node.js 20、22 和 24，建议使用当前 Node.js 22 LTS。安装与启动：

```bash
npm ci
npm run dev
```

## 提交检查

提交 Pull Request 前运行：

```bash
npm run check
npm run audit:prod
```

修改文档处理、网络重试、设置持久化或 IPC 边界时，请添加覆盖成功、失败和取消路径的测试。不要提交 `node_modules/`、`dist/`、`release/`、API 密钥、用户设置、真实待翻译文档或包含个人信息的日志。

## Pull Request

- 说明用户可见行为和技术取舍。
- 列出已执行的测试；无法执行 Windows 打包时明确说明。
- 保持改动聚焦，不混入无关格式化或重构。
- UI 变更应附桌面窗口截图并检查最小窗口尺寸。

提交贡献即表示你同意按项目的 MIT License 发布相关代码和文档。
