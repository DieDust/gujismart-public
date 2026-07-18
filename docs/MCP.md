# GujiSmart MCP（AI 工具连接）

让 **Trae、Cursor、Claude 桌面版、Codex** 等本机 AI 工具只读访问你的文献库。
**普通用户不必会敲命令、不必知道盘符。**

## 给电脑小白（推荐）

1. 打开 **文献管理 → 设置 → AI 工具连接**。
2. 打开 **「允许 AI 工具访问文献库」**。
3. 在 **「你用的是哪家 AI 客户端？」** 里切换（默认 **Trae**，国内较常用；也可选 Cursor / Claude / Codex / 其他）。
4. 按当前客户端面板上的步骤操作（复制 JSON，或 Codex 一键写入）。
5. **重启对应 AI 客户端** 后，在对话里直接问文献库问题。

### Trae / Cursor / Claude / 其他（JSON）

1. 切换到对应客户端。
2. 点 **「复制 MCP 配置 JSON」**。
3. 粘贴到该软件的 MCP / 本地工具设置（类型 **STDIO**）。

配置会自动带上程序路径、数据目录、连接令牌（**不必自己写盘符**）。

### Codex

Codex **不能**在无配置时自己发现本机软件（安全设计）。可选：

1. **推荐**：点 **「一键写入 Codex 配置」**，然后完全退出并重新打开 Codex。
2. **手填表单**：类型选 **STDIO**，按设置页「手动表单对照」逐项粘贴名称、启动命令、参数，以及环境变量 **`ELECTRON_RUN_AS_NODE=1`**（Windows 必需，否则会一直「重新连接」）。

说明：

- `gujismart` **不会**出现在 Codex 左侧「插件」列表（那是 Documents/PDF 等内置插件）。
- 配置成功后，在对话里直接问文献库即可；列表里可能显示「不支持身份验证 / 已启用」，这是本地 STDIO 的正常状态。
- 若出现 Electron 弹窗 `Unable to find Electron app` 或 MCP「正在重新连接」，请重新点一键写入并完全重启 Codex（旧配置用全量 Electron 启 UI 会在 Windows 上断开 stdin）。

> 只有网页版聊天、不支持 MCP 的 AI，无法用此功能。

## 安全

- **只读**：可检索、看元数据、读页文；**不能**删除文献、改设置、读 API Key。
- 默认关闭；你主动打开开关后才可用。
- 可随时 **关闭开关** 或 **更换连接令牌**（换令牌后需在客户端重新写入/粘贴配置）。

## 高级用户（命令行）

仍可用工程内脚本（需 Node 依赖）：

```bash
# 需先在设置中打开「允许 AI 工具访问」，并带上令牌；或开发时设 GUJISMART_MCP_DEV=1
npm run mcp -- --data-dir "<你的数据目录>" --mcp-token "<令牌>"
```

更省事的方式仍是设置里按客户端一键复制（已含路径与令牌）。

## 工具一览

| Tool | 作用 |
|------|------|
| `library_search` | 全库检索（默认 **compact**：标题/页码/短摘录/`ref`；`detail:"full"` 才带完整 locator） |
| `list_documents` | 文献列表（精简元数据，无本地路径） |
| `get_document` | 元数据；默认不含逐页清单，`includePages:true` 才展开 |
| `get_page_text` | 页正文（默认不含 content hash） |
| `resolve_evidence` | 出处解析（需 full locator；日常阅读优先 `get_page_text`） |
| `list_folders` / `list_tags` | 文件夹与标签 |
| `library_stats` | 统计 |

默认返回刻意压短，避免把 `sourceHash` / `contentVersion` / `sourceRanges` 等机读字段灌进 AI 上下文；桌面端界面检索不受影响。

## 开发自检

```bash
npm run check:mcp
```
