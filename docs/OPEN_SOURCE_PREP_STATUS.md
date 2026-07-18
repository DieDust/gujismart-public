# 开源准备状态（1.1.6 候选）

本文记录当前仓库在公开前的准备情况。正式推送标签与创建 GitHub Release 仍须遵守 [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md)。

## 已具备（公开仓库卫生）

| 项 | 状态 |
| --- | --- |
| 许可证 Apache-2.0 | 有 `LICENSE` |
| 归属 / 第三方声明 | 有 `NOTICE`、`THIRD_PARTY_NOTICES.md` |
| 贡献与安全说明 | 有 `CONTRIBUTING.md`、`SECURITY.md` |
| Issue / PR / CI 模板 | 有 `.github/` |
| 发布流程文档 | 有 `docs/OPEN_SOURCE_RELEASE.md` |
| 忽略产物与用户数据 | `.gitignore` 含 `data/`、`dist/`、`out/`、`.env`、`node_modules/` 等 |
| 开源卫生扫描 | `npm run check:opensource` 通过 |
| 乱码扫描 | `npm run check:mojibake` 通过 |
| 生产依赖审计 | `npm audit --omit=dev`：0 vulnerabilities |
| 安装包命名约定 | `GujiSmart-X.Y.Z-Setup-x64.exe` / `Portable` |

## 当前版本候选

- 计划版本：**1.1.6**
- 标签计划：`v1.1.6`（仅在 main CI 成功后打一次）
- 本地已生成（不入库，仅维护者测试用）：
  - `dist/GujiSmart-1.1.6-Setup-x64.exe`
  - `dist/GujiSmart-1.1.6-Portable-x64.exe`
  - 成品含 `resources/mcp/mcp-host.cjs`（Windows Codex MCP 修复所需）
- 主要用户向变更：修复 Windows 上 Codex/MCP stdin 断开导致工具列表为空；MCP 改为 `ELECTRON_RUN_AS_NODE` + `mcp-host.cjs`；一键写入带必要 env。详见 `CHANGELOG.md` 1.1.6。

## 候选提交应包含的文件（待 commit）

- `package.json` / `package-lock.json` → 1.1.6
- `CHANGELOG.md` 1.1.6 中英笔记
- MCP 宿主：`scripts/build-mcp-host.js`、`scripts/stubs/electron-app-shim.js`、`scripts/gujismart-mcp.js`
- MCP 核心：`src/main/mcp/{connection,cli,stdio-server}.ts`、`src/shared/types.ts`
- UI / 文档：`SettingsView.tsx`、`docs/MCP.md`、本文件
- 回归：`scripts/mcp-tools-regression.js`
- `package.json` `build` 链增加 `build:mcp-host`；`extraResources` 打包 `mcp-host.cjs`

**禁止提交：** `data/`、`dist/`、`out/`、`tmp/`、密钥、真实文献、本机 Codex token 配置。

## 发布前仍须完成（维护者操作）

按 [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md) 五阶段：

1. **工作区提交**  
   将 1.1.6 候选提交到 `main`（勿提交 `data/`、`dist/`、密钥）。
2. **干净环境完整门禁**（推送前已在本机跑过一轮；若再改代码须重跑）：

   ```powershell
   npm run check
   npm run smoke
   npm audit --omit=dev
   npx electron-builder install-app-deps
   npm run build:win
   npm run smoke:packaged
   npm run check:mojibake
   npm run check:opensource
   git diff --check
   ```

3. **维护者安装测试**  
   使用同一候选的 Setup + Portable：启动、库兼容、设置 → AI 工具连接 → Codex 一键写入后重启 Codex，确认 MCP 工具可加载（`library_stats` / 检索）。书面批准公开。
4. **先 push `main`，等 CI 成功**，再打 **一次** `v1.1.6` 标签触发 Release（禁止 main 与 tag 同时推）。
5. **Release 只上传两个 exe**，notes 与 CHANGELOG 1.1.6 一致。

## 公开内容注意

- README 截图：本版无强制界面重拍要求（设置 MCP 文案有小更新，截图可沿用已核验图）。
- 文档禁止硬编码维护者本机绝对路径、真实文献 ID、私有语料名、API Key / MCP token。
- 升级用户须在 1.1.6 中 **重新一键写入** Codex/JSON 配置（旧 MCP 启动参数在 Windows 上无效）。

## 本轮本地已完成的准备动作

- 版本与 lockfile 对齐 1.1.6；CHANGELOG 中英就绪。
- MCP Windows 修复与 `mcp-host` 打包链路落地；`check` / `smoke` / `build:win` / `smoke:packaged` 通过。
- `check:opensource`、`check:mojibake`、`npm audit --omit=dev` 通过。
- `dist/`、`out/`、`data/` 仍被 gitignore。

更新本文件日期：2026-07-18，对应 1.1.6 开源准备。
