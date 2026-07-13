# 开源发布操作规范

本文面向 GujiSmart 维护者。目标是让每个公开版本只触发一次正式 Release 构建，并一次性发布完整的 Windows 安装包。

## 先完成候选版本，再创建标签

公开发布必须分成五个阶段，顺序不能调整：

1. 冻结候选提交。
2. 在本地完成干净环境检查、打包和成品测试。
3. 由维护者安装测试并明确批准公开。
4. 只推送 `main`，等待 GitHub CI 成功。
5. CI 成功后再创建一次版本标签，由 Release workflow 打包并发布。

`main` 和版本标签不能同时推送。先证明远程 CI 能通过，再触发会生成安装包的 Release workflow，可以避免同一个错误同时消耗两套 Windows Runner。

## 冻结发布内容

创建候选提交前，检查以下内容：

- `package.json`、`package-lock.json`、`CHANGELOG.md` 和计划发布的 `vX.Y.Z` 使用同一版本。
- README 截图必须与当前可见界面和说明一致，并使用隔离数据库和合成数据。没有可见 UI 变化时沿用已核验截图，不因版本号或后台实现变化重复拍摄。
- Release notes 中英文内容一致，并列出 Setup 和 Portable 两种下载。
- `dist/`、`out/`、`data/`、`node_modules/`、日志、数据库、真实文献和 API Key 没有进入 Git 跟踪。
- 工作区没有与发布无关的修改。

运行：

```powershell
git status --short
git diff --check
git check-ignore -v dist out data node_modules
```

如果候选提交之后又修改了代码、测试、截图、版本或发布说明，这个候选立即失效，必须重新从本节开始。

## 在本地完成完整门禁

在将候选提交推送到 GitHub 前运行：

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

然后核对本地产物：

```powershell
Get-ChildItem dist -File
Get-FileHash dist\GujiSmart-X.Y.Z-Setup-x64.exe -Algorithm SHA256
Get-FileHash dist\GujiSmart-X.Y.Z-Portable-x64.exe -Algorithm SHA256
```

本地门禁必须满足：

- `npm run check` 从干净的 `out/` 状态也能运行，完整应用测试不能依赖上一次遗留的构建文件。
- Setup 和 Portable 都能生成，`smoke:packaged` 能从打包成品启动应用。
- 只有两个面向用户的 `.exe` 会进入 Release；`.blockmap` 和 `latest.yml` 不上传。
- `npm audit` 和 `npm audit --omit=dev` 没有未处理的高危问题。
- 所有截图经过人工目视检查。只有界面发生可见变化、截图内容已经过期、与当前默认行为冲突或存在隐私风险时才重拍；纯性能、后台逻辑和版本号更新不要求换图。

本地测试失败时禁止 push 标签。修复后必须重新运行完整门禁，不能只运行最后失败的单项。

## 先让维护者测试本地安装包

把同一候选提交生成的 Setup 和 Portable 交给维护者测试。至少确认：

- 新装和便携版都能启动。
- 原数据库和文献目录兼容。
- 导入、OCR、阅读器、检索、AI 配置和批量操作没有阻断问题。
- 安装包版本、文件名和候选版本一致。

只有维护者明确回复“本地测试通过并批准公开”后，才能执行远程发布。默认沉默、只说“可以继续”或只批准本地打包，都不等于批准公开。

## 先推送 main，并等待 CI 成功

只推送候选提交：

```powershell
git push origin main
gh run list --repo DieDust/gujismart-public --limit 6
gh run watch <CI_RUN_ID> --repo DieDust/gujismart-public --exit-status
```

必须确认最新 CI 满足：

- `headSha` 等于候选提交。
- `status` 为 `completed`。
- `conclusion` 为 `success`。
- `Check` 和 `Build` 都成功。

`gh run watch` 的 TLS handshake timeout 只表示本地监控连接失败。遇到这种情况应重新查询原 run，不能重新 push、重新打标签或重新触发工作流：

```powershell
gh run view <CI_RUN_ID> --repo DieDust/gujismart-public --json status,conclusion,jobs,url,headSha
```

## CI 成功后只创建一次发布标签

确认候选提交 SHA 后运行：

```powershell
git tag vX.Y.Z <APPROVED_COMMIT_SHA>
git push origin refs/tags/vX.Y.Z
```

每个版本只能创建和推送一次标签。禁止：

- 在 CI 未成功前推送标签。
- 使用 `git tag -f` 移动已推送标签。
- 删除远程标签后指向另一个提交。
- 在同一版本上反复重跑并覆盖公开资产。
- 手工把本地 `dist/` 中的旧安装包上传到 Release。

如果标签触发的 Release workflow 失败，这个版本号视为已使用。修复问题后增加补丁版本，并从冻结候选阶段重新开始。这样可以保证一个公开标签始终对应一个不可变提交和一组不可变产物。

## 等待 Release 一次性完成

Release workflow 必须按以下顺序完成：

```text
npm ci
  -> check
  -> build:win
  -> smoke:packaged
  -> 校验标签、package.json 与两个 EXE 文件名一致
  -> 上传 workflow artifact
  -> 创建草稿 GitHub Release
  -> 上传并远程核对两个 exe
  -> 核对成功后转为公开 Release
```

在 `Check`、`Build Windows packages`、`Smoke test packaged application` 或资产核对未成功前，不得创建公开 Release。Release workflow 只能先创建草稿；两个 EXE 均上传并确认名称、数量正确后才能公开。任何一步失败都应删除未完成草稿但保留不可变标签，修复后使用下一个补丁版本。维护者必须等待原 workflow 结束，不能因为暂时没有输出就再次推送标签。

运行：

```powershell
gh run watch <RELEASE_RUN_ID> --repo DieDust/gujismart-public --exit-status
gh release view vX.Y.Z --repo DieDust/gujismart-public --json assets,url,name,tagName,isDraft,isPrerelease
```

## 发布后核对远程事实

发布完成后执行：

```powershell
$main = gh api repos/DieDust/gujismart-public/git/ref/heads/main | ConvertFrom-Json
$tag = gh api repos/DieDust/gujismart-public/git/ref/tags/vX.Y.Z | ConvertFrom-Json
$release = gh release view vX.Y.Z --repo DieDust/gujismart-public --json assets,url | ConvertFrom-Json

[pscustomobject]@{
  MainSha = $main.object.sha
  TagSha = $tag.object.sha
  Same = $main.object.sha -eq $tag.object.sha
  Assets = ($release.assets.name -join ', ')
  Url = $release.url
}
```

最终验收必须满足：

- 仓库仍为 `PUBLIC`，默认分支为 `main`。
- 发布时 `main` 和版本标签指向同一获批提交。
- CI 和 Release workflow 都是 `completed/success`。
- Release 不是 draft，也不是 prerelease。
- 手工上传的资产严格为：
  - `GujiSmart-X.Y.Z-Setup-x64.exe`
  - `GujiSmart-X.Y.Z-Portable-x64.exe`
- Release notes 与 `CHANGELOG.md` 对应版本一致。
- 本地工作区干净。

## 1.1.0 发布问题与防再发规则

| 已发生的问题 | 根因 | 以后必须执行的规则 |
| --- | --- | --- |
| Windows CI 连续在不同测试位置失败 | 测试写死 LF、路径大小写和临时目录字符串 | 换行断言兼容 CRLF；路径比较使用 `path.relative` 或与生产代码相同的 `realpath` API，不比较原始短路径字符串 |
| `RUNNER~1` 与 `runneradmin` 被判断为不同路径 | Windows 8.3 短路径、大小写和同步/异步 `realpath` 行为不同 | 回归测试必须覆盖路径别名；期望值使用与生产代码相同的同步或异步 API |
| 最后的 Electron 测试在 CI 超时 180 秒 | 测试依赖本地遗留的 `out/main/index.js`，干净 Runner 尚未 build | 完整应用测试必须自行准备构建入口；验证时先清理 `out/`，不能以本机旧产物通过作为证据 |
| `main` 与标签同时推送，CI 和 Release 重复执行失败检查 | 没有先用 main CI 验证候选提交 | 先推 `main` 并等待 CI 成功，再且只再推一次标签 |
| 同一个 `v1.1.0` 标签被多次删除和重建 | 标签创建得太早，后续用移动标签修复发布 | 远程标签不可移动；Release 失败后使用下一个补丁版本 |
| README 发布后仍显示旧界面 | 删除含真实数据的新截图后，回退到已经过时的安全截图且没有复核 | 截图属于候选冻结内容；有可见界面变化或内容过期时才用隔离数据库和合成数据重拍，无 UI 变化时沿用并逐张目视检查 |
| GitHub 监控命令 TLS 超时 | 本地到 GitHub API 的短暂网络故障 | 查询同一个 run 的真实状态；网络错误不得触发重复 push、tag 或打包 |
| 担心安装包混入无关文件 | 本地 `dist/out/data` 与 Release 资产边界没有在每次发布前重新核对 | 发布前检查 ignore；安装包由 Actions 从标签构建；Release 只上传两个 `.exe` |

这张表记录的是已经发生过的问题，不是可选建议。后续发布如果绕过对应规则，应立即停止发布并回到候选冻结阶段。
