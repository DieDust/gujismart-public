# 开源准备基线

本文记录 GujiSmart 公开发布时必须保持的仓库基线。每个版本的实时构建与发布状态以 GitHub Actions 和 GitHub Releases 为准；具体操作顺序见 [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md)。

## 公开仓库内容

仓库应只包含源码、配置、锁文件、公开文档、许可证声明、CI / Release 工作流、安全的合成截图与自包含测试。

| 项目 | 要求 |
| --- | --- |
| 许可证 | `LICENSE` 使用 Apache-2.0 |
| 归属与第三方声明 | 保留 `NOTICE`、`THIRD_PARTY_NOTICES.md` |
| 贡献与安全说明 | 保留 `CONTRIBUTING.md`、`SECURITY.md` |
| 开源卫生 | `npm run check:opensource` 与 `npm run check:mojibake` 通过 |
| 安装包 | 只在 GitHub Release 发布 Setup 与 Portable 两个 EXE |
| 截图 | 只使用隔离数据库和合成数据，并在界面明显变化时更新 |

以下内容不得进入 Git 跟踪或 Release 源码：

- `data/`、本地数据库、备份、OCR 页图和真实文献；
- `dist/`、`out/`、`tmp/`、`node_modules/` 和本机日志；
- `.env`、API Key、访问令牌和凭据文件；
- 私有语料名、真实文献 ID、本机绝对路径和临时排障脚本；
- `.blockmap`、`latest.yml` 等未启用自动更新时不面向用户的产物。

仓库内 `resources/vendor/qpdf/` 是应用运行所需的受控第三方组件，其来源与许可证记录在 `THIRD_PARTY_NOTICES.md`，不属于用户数据或本机构建产物。

## 发布前检查

每次公开版本必须从冻结候选重新运行完整门禁：

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

随后只推送 `main` 并等待对应 CI 成功。CI 通过后才创建一次不可变版本标签，由 Release workflow 构建并核验：

- `GujiSmart-X.Y.Z-Setup-x64.exe`
- `GujiSmart-X.Y.Z-Portable-x64.exe`

`main` 与标签不能同时推送，失败标签不能移动或覆盖。发布完成后必须再次核对仓库可见性、默认分支、提交 SHA、工作流结论、Release 正文和资产列表。
