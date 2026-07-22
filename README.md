# 文献管理（GujiSmart）

文献管理（GujiSmart）是一个面向古籍与通用文献的本地研究工作台，围绕“导入资料、OCR 校对、检索证据、摘录到写作”的闭环整理个人文献库。

最新安装包见 [GitHub Releases](https://github.com/DieDust/gujismart-public/releases)（当前 **v1.1.20+**）。完整图文教程见 [docs/文献管理-图文使用教程.md](docs/文献管理-图文使用教程.md)。

## 界面预览

以下截图使用空库或合成示例数据，不包含真实用户文献。界面若有迭代，以软件内实际界面为准；维护者可用隔离数据目录重拍 `docs/images/tutorial-*.png`。

| 欢迎页 | 文献库 |
| --- | --- |
| ![欢迎页](docs/images/tutorial-01-welcome.png) | ![文献库](docs/images/tutorial-02-library.png) |

| 研究工作台 | 全文检索 |
| --- | --- |
| ![研究工作台](docs/images/tutorial-03-research.png) | ![全文检索](docs/images/tutorial-04-search.png) |

| 引用格式 | 标签管理 |
| --- | --- |
| ![引用格式](docs/images/tutorial-05-citation.png) | ![标签管理](docs/images/tutorial-06-tags.png) |

| 处理队列 | 设置 |
| --- | --- |
| ![处理队列](docs/images/tutorial-07-dashboard.png) | ![设置](docs/images/tutorial-08-settings.png) |

## 功能概览

- **文献导入**：支持 PDF、常见图片格式和本地文件夹归档；可开启导入后自动 OCR。
- **OCR 与校对**：批量 OCR、飞桨多 Token 额度接力、视觉/混合 OCR、单页重识别；单页失败可入库并标出失败页；校对支持原图对照、鸟瞰定位、版式还原、多版本识别结果。
- **原文管理**：PDF 原件仓库匹配与补回；可选“仅登记路径”不复制大文件；清理 OCR 原图只删软件目录内副本，不删外部源文件。
- **页码与导出**：自然页码 / 文献（印刷）页码校准；导出可选页码模式。
- **向量检索**：正文 Embedding 索引；文献库批量向量化（可先 OCR 再向量，已识别书不重复整本 OCR）；检索页独立向量库检索与文内命中导航。
- **文献组织**：标签、文件夹、收藏、阅读状态、评分、智能筛选和元数据维护。
- **检索与证据**：全文检索、语义扩展/AI 检索（视配置）、保存检索和摘录保存；向量证据导出。
- **AI 辅助**：OpenAI 兼容接口，用于元数据提取、文献问答、总结和跨文献综合。
- **研究写作**：研究项目、摘录、引用模板和 Markdown/JSON 等导出。
- **AI 工具连接（MCP）**：设置中一键开关与配置复制；本机 Agent（Cursor / Claude / Codex / Trae 等）可只读检索文献库。详见 [docs/MCP.md](docs/MCP.md)。

## 技术栈

- 桌面框架：Electron
- 前端：React 18 + TypeScript + Vite
- UI：Ant Design 5
- 本地数据库：`better-sqlite3` + SQLite
- OCR：PaddleOCR API / 视觉模型 OCR
- AI / 向量：OpenAI 兼容 Chat 与 Embeddings 接口

## 快速开始

### 普通用户

前往 [GitHub Releases](https://github.com/DieDust/gujismart-public/releases) 下载最新安装包即可。

### 开发者

```bash
npm install
npm run dev
```

## 常用脚本

```bash
npm run typecheck
npm run check
npm run build
npm run smoke
npm run check:mcp
```

- `npm run typecheck`：运行 TypeScript 类型检查。
- `npm run check`：运行类型检查、合同回归、乱码检查和开源卫生检查。
- `npm run build`：构建 Electron main、preload 和 renderer。
- `npm run smoke`：运行 Electron 冒烟测试。
- `npm run check:mcp`：检查 AI 工具（MCP）合同与只读工具集成。
- `npm run mcp`：开发态 headless MCP 启动（需数据目录；最终用户优先用设置页一键配置）。

更多回归测试和脚本卫生规则见 [docs/SCRIPTS.md](docs/SCRIPTS.md)。维护者发布新版本前必须遵循 [开源发布操作规范](docs/OPEN_SOURCE_RELEASE.md)。依赖本地私有文献库的人工 QA 脚本不进入公开仓库。

## 配置说明

应用使用本地 SQLite 与托管目录保存文献、OCR 结果、标签、项目和设置。

- 开发模式：数据默认在项目内的 `data/` 目录。
- 安装版 / 便携版：数据默认在可执行文件同级的 `data/` 目录（设置 → 数据管理 →「打开数据目录」可确认）。
- 也可用环境变量 `GUJISMART_DATA_DIR` 指定数据根目录。

AI/OCR 相关 API Key 不应写入仓库，请在应用设置页中配置。开源贡献时不要提交真实数据库、真实文献、用户目录、日志或临时调试输出。
飞桨云端 OCR 的多 Token 接力、100 页分段和失败分段续跑规则见 [PaddleOCR 多 Token 接力说明](docs/PADDLE_OCR_TOKEN_POOL.md)。
AI 工具连接（MCP）见 [docs/MCP.md](docs/MCP.md)。
如需本地调试环境变量，请复制 `.env.example` 为 `.env`，并只在本机填写真实值。

## 项目结构

```text
src/main/        Electron main 进程、数据库、OCR、AI、向量、导出、IPC 与 MCP
src/preload/     安全暴露给 renderer 的 window.api
src/renderer/    React 前端界面、状态和工具函数
src/shared/      main/preload/renderer 共享类型、常量和跨进程工具
scripts/         冒烟测试、回归测试、MCP 启动器和仓库维护脚本
docs/            使用文档、开源发布规范与截图素材
```

架构边界、IPC 合同和命名规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。脚本分类见 [docs/SCRIPTS.md](docs/SCRIPTS.md)。后续整理方向见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 更新日志

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 开源协作

欢迎提交 issue 和 pull request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。提交 PR 前至少运行：

```bash
npm run check
npm run build
```

## 许可证与第三方声明

本项目使用 [Apache License 2.0](LICENSE)。

项目版权和必须保留的归属声明见 [NOTICE](NOTICE)。随包第三方运行时组件、直接 npm 依赖和构建工具许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 作者

- GitHub: [DieDust](https://github.com/DieDust)
