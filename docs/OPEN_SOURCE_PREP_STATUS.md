# 开源准备状态（1.1.10 候选）

本文记录当前仓库在公开前的准备情况。正式推送标签与创建 GitHub Release 仍须遵守 [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md)。

## 已具备（公开仓库卫生）

| 项 | 状态 |
| --- | --- |
| 许可证 Apache-2.0 | 有 `LICENSE` |
| 归属 / 第三方声明 | 有 `NOTICE`、`THIRD_PARTY_NOTICES.md` |
| 贡献与安全说明 | 有 `CONTRIBUTING.md`、`SECURITY.md` |
| Issue / PR / CI 模板 | 有 `.github/` |
| 发布流程文档 | 有 `docs/OPEN_SOURCE_RELEASE.md` |
| 忽略产物与用户数据 | `.gitignore` 含 `data/`、`dist/`、`out/`、`.env`、`node_modules/`、`electron-user-data*/` 等 |
| 开源卫生扫描 | `npm run check:opensource` 通过（本轮本地已跑） |
| 乱码扫描 | `npm run check:mojibake` 通过 |
| 安装包命名约定 | `GujiSmart-X.Y.Z-Setup-x64.exe` / `Portable` |
| 生产依赖审计 | 见下方「依赖」；`brace-expansion` 已抬到 `^5.0.7` 并 override |

## 当前版本候选

- 计划版本：**1.1.10**
- 标签计划：`v1.1.10`（仅在 `main` CI 成功后打一次）
- 远程 `origin/main` 当前仍为 **1.1.7**（`d3f98dc`）；1.1.8–1.1.10 变更主要在本地工作区，**尚未形成可推送的冻结提交**。
- 本地已生成（不入库，仅维护者测试用）：
  - `dist/GujiSmart-1.1.10-Setup-x64.exe`
  - `dist/GujiSmart-1.1.10-Portable-x64.exe`
- 主要用户向变更摘要：见 `CHANGELOG.md` 1.1.10（OCR 单页失败可入库、批量 OCR、向量化不重跑 OCR、错页短提示/鸟瞰、PDF 仅登记路径、清理不删外置、豆包视觉连接测试等）。

## 候选提交应包含的范围（待 commit）

工作区约有数十个已修改源文件/脚本/类型与设置定义，大致包括：

- 版本：`package.json` / `package-lock.json` → 1.1.10
- 发布说明：`CHANGELOG.md` 1.1.10 中英
- OCR / 批量 / 超时 / 结算复核：`src/main/ipc/ocr.ts`、`batch-processor.ts`、相关 regression
- 向量与文库：`embedding-index.ts`、`LibraryView.tsx`、`FoldersView.tsx` 等
- PDF 资产：`pdf-assets.ts`（链接补回 + 清理硬闸）、`SettingsView` 开关、types / settings
- 视觉 OCR 测试图：`vision-ocr-verification.ts`
- 错页 UI：`PageBirdseyeGrid.tsx`、`DocumentView.tsx`
- 导出页码、检索/阅读相关：`export.ts`、`search.ts`、`SourcePageReader.tsx` 等
- 本文件：`docs/OPEN_SOURCE_PREP_STATUS.md`

**禁止提交：**

| 路径/类型 | 原因 |
| --- | --- |
| `data/` | 真实库、备份、OCR 页图、密钥目录 |
| `dist/`、`out/`、`tmp/`、`dist-archive/` | 构建产物 |
| `node_modules/` | 依赖安装结果 |
| `electron-user-data*/`、本机日志 | 用户运行态 |
| `.env`、API Key、MCP token | 密钥 |
| 真实文献 ID、私有语料路径、本机绝对路径硬编码 | 隐私 / 开源卫生 |
| `docs/*.docx` | 已 ignore；勿强行 add |

提交前自检：

```powershell
git status --short
git diff --check
git check-ignore -v dist out data node_modules
git ls-files | Select-String -Pattern 'data/|dist/|\.db$|secrets|credentials'
```

`git ls-files` 对上述敏感路径应**无输出**（`.env.example` 可保留）。

## 发布前仍须完成（维护者操作）

按 [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md) 五阶段，**当前进度**：

| 阶段 | 状态 |
| --- | --- |
| 0. 卫生扫描 / 文档 / 本地包 | 部分完成：opensource、mojibake、本地 build:win 已做过；**完整 `npm run check` 与 `smoke:packaged` 在冻结提交前须重跑** |
| 1. 冻结候选提交 | **未完成**（工作区脏、未 commit） |
| 2. 干净环境完整门禁 | **未完成**（须在 commit 后对干净树重跑） |
| 3. 维护者安装测试 + 书面批准公开 | **未完成** |
| 4. 先 push `main`，等 CI 成功 | **未完成** |
| 5. 再打一次 `v1.1.10` 标签发 Release | **未完成**（禁止 main 与 tag 同时推） |

完整门禁（推送前）：

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

## 公开内容注意

- README 截图：1.1.10 设置「PDF 原件仓库」有新开关文案；若 README 未展示该屏可沿用旧图；若截图含设置 OCR/PDF 区且已过期则用隔离库合成数据重拍。
- 文档禁止硬编码维护者本机绝对路径、真实文献 ID、私有语料名、API Key / MCP token。
- Release 只上传两个 exe：`Setup` + `Portable`；不上传 blockmap / latest.yml。
- 一个失败过的远程标签不可移动；失败则升补丁版本重走流程。

## 本轮本地已完成的准备动作（2026-07-22）

- 版本目标对齐 **1.1.10**；CHANGELOG 1.1.10 已扩写本轮用户可见项。
- `npm run check:opensource`、`check:mojibake` 通过。
- `brace-expansion` 抬至 `^5.0.7` 并加入 `overrides`（缓解 audit high）。
- 确认 `data/`、`dist/`、`out/` 在 ignore 中；`git ls-files` 未跟踪库文件/密钥。
- 本地多次 `build:win` 产出 1.1.10 Setup/Portable（**不入库**）。
- 清理 PDF / 链接补回 / 托管删除闸门已落地（开源安全叙事的一部分）。

## 建议的下一步（按顺序）

1. 维护者 review 工作区 diff，去掉临时笔记/调试残留。
2. 一次干净 commit（或少量逻辑提交）落到 main，message 指向 1.1.10。
3. 对冻结提交重跑完整门禁（上表命令）。
4. 安装 Setup + Portable 做冒烟（导入、OCR、补回/清理、向量、豆包视觉测试连接）。
5. 明确回复「本地测试通过并批准公开」后：git push origin main → 等 CI → 仅打 v1.1.10。

更新本文件日期：2026-07-22，对应 1.1.10 开源准备。
