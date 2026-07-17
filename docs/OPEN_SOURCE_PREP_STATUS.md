# 开源准备状态（1.1.5 候选）

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

- 计划版本：**1.1.5**
- 本地已生成（不入库，仅维护者测试用）：
  - `dist/GujiSmart-1.1.5-Setup-x64.exe`
  - `dist/GujiSmart-1.1.5-Portable-x64.exe`
- 主要用户向变更：大库卡顿优化、飞桨 429/额度区分、AI 工具连接（MCP）与设置一键配置等。详见 `CHANGELOG.md`。

## 发布前仍须完成（维护者操作）

按 [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md) 五阶段，当前仍属「冻结候选」之前或之中：

1. **工作区提交**  
   将本轮功能与文档提交到 `main`（勿提交 `data/`、`dist/`、密钥、真实文献）。
2. **干净环境完整门禁**（推送前）：

   ```powershell
   npm ci
   npm run check
   npm run smoke
   npm audit
   npm audit --omit=dev
   npx electron-builder install-app-deps
   npm run build:win
   npm run smoke:packaged
   npm run check:mojibake
   npm run check:opensource
   git diff --check
   ```

3. **维护者安装测试**  
   使用同一候选提交的 Setup + Portable 做启动、兼容库、导入/OCR/检索/设置/MCP 冒烟；书面批准公开。
4. **先 push `main`，等 CI 成功**，再打 **一次** `v1.1.5` 标签触发 Release（禁止 main 与 tag 同时推、禁止移动已推送标签）。
5. **Release 只上传两个 exe**，notes 与 CHANGELOG 1.1.5 一致。

## 公开内容注意

- README 截图须为空库/合成数据；无界面可见变化时沿用并目视检查。
- 文档禁止硬编码维护者本机绝对路径、真实文献 ID、私有语料名、API Key。
- MCP 文档仅说明设置一键流程与工具名；不要求用户理解盘符。
- `docs/refactor-audit/` 等为工程审阅材料，确认无隐私路径与密钥后再公开保留。

## 本轮已在仓库内做的准备动作

- 更新 README / CONTRIBUTING / SECURITY 中与 MCP、数据目录、卫生相关的说明。
- 保留并文档化 `docs/MCP.md`、`docs/OPEN_SOURCE_RELEASE.md`。
- 确认 `check:opensource`、`check:mojibake`、`npm audit` 当前通过。

更新本文件日期：与 1.1.5 开源准备同步。
