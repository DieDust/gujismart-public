# 07 AI 对话与 AI 研究

## 1. 本章结论

GujiSmart 当前已经形成三条可用的 AI 主流程：文献内与文库范围的证据问答、跨文献综合分析、以及“研究目标 -> 检索计划 -> 本地统计 -> 代表证据包 -> 结构化记录 -> 研究报告”的 AI 研究工作流。系统还具备对话会话、流式回答、来源卡片、研究专题、大纲、摘录、数据集、报告、引用与导出等基础。这些能力说明产品方向是成立的，不应把 AI 重构简化为更换模型或重画聊天框。

当前最严重的问题是 AI 结果缺少一条可信、可恢复、可复现的执行链。LLM、视觉 OCR 与 PaddleOCR 三类凭据都以明文写入 SQLite，普通设置 API、服务商 profile、模型列表请求和数据库备份都可携带完整密钥；该问题属于隐私与凭据泄露风险，应按跨模块 P0 处理。正文读取、检索证据、研究摘录、数据集和报告又分别生成或接受不同的 `source_hash/locator`，只要字段非空就被视为“有来源”，没有验证它是否仍能解析到当前 canonical 原文。流式失败会重新检索生成答案，却继续绑定旧证据；会话也没有校验文献和 scope 身份。用户看到的“有引用、有置信度、有历史”因此还不等于结果可复核。

AI Research 当前也不是持久任务系统。检索统计、证据压缩、逐条模型抽取和报告生成直接运行在 IPC 调用中，没有可用的取消、暂停、租约、断点、重启恢复或幂等 attempt。文献总量逻辑上无限，但多处仍一次性物化 scope、会话、任务、数据集、报告或导出；renderer 又用 1000 篇和 20 条静默截断制造“完整列表/完整数据集”的错觉。研究统计还把不同查询的文献数和页数直接相加，多词查询只统计第一个词的 occurrence，最多 1000 条样本产生的分面却没有近似标记。

本章建议把 AI 重构为六个共享层：main-only 的凭据保险库；复用 OCR/阅读器/检索的 canonical content 与 evidence resolver；冻结模型、提示词和 scope 的 `AiExecutionContext`；绑定 generation、覆盖率与 continuation 的 evidence pack；复用导入/OCR 统一 scheduler 的可恢复 AI job；以及默认“人工确认后才能进入正式报告”的研究数据与输出 lineage。古籍用户和普通 PDF/论文用户继续使用同一底座，通过研究模板、检索词典、证据精度和阅读模式配置兼容，不在源码中写死某一历史语料的实体扩展。

第一阶段不需要更换 SQLite，也不需要新增第三方依赖。Electron 自带 `safeStorage` 可用于本机密钥加密；密文放入 `userData` 下独立、版本化、main-only 的凭据 sidecar，现有 `settings` 表只保存非敏感 profile 元数据和 vault 引用，普通数据库备份不携带 secret blob。sidecar 与 SQLite 通过 prepare/activate/finalize journal 恢复，而不是宣称文件写入和数据库事务天然原子。canonical content、evidence resolver 和统一 scheduler 必须分别复用模块 03/05、06、02/03 的目标能力，不建立第二套正文、检索或任务真相。任务租约、幂等唯一约束、记录复核版本、aggregate provenance 与输出 lineage 等核心验收依赖的结构必须采用旁路 additive migration，并严格执行预检、脱敏备份、事务、幂等、失败回滚和兼容读取。

## 2. 审阅范围与现状验证

本章完整阅读或复核了以下主归属文件：

- `src/main/ai.ts`
- `src/main/evidence-qa.ts`
- `src/main/ai-research-retrieval.ts`
- `src/main/ipc/ai.ts`
- `src/main/ipc/ai-research.ts`
- `src/main/ipc/research.ts`
- `src/renderer/src/components/AiMarkdown.tsx`
- `src/renderer/src/components/AiPanel.tsx`
- `src/renderer/src/components/AiSynthesisModal.tsx`
- `src/renderer/src/views/ResearchView.tsx`
- `src/shared/ai-response-envelope.ts`
- `src/shared/research-integrity.ts`
- `src/shared/research-locator.ts`
- `src/shared/research-output-snapshot.ts`

同时复核了 `src/shared/types.ts` 的 AI/研究合同、`src/preload/index.ts` 的完整桥接、`src/main/database.ts` 的 AI/研究表与兼容建表、`src/main/ipc/settings.ts` 的 LLM/OCR profile 和密钥路径、`src/main/backup.ts` 的数据库备份、`src/main/startup-recovery.ts`、`src/main/background-tasks.ts`、`src/main/semantic-search.ts` 的 AI 搜索入口，以及 App、DocumentView、LibraryView 中的 AI 面板入口。全部 AI/研究公开回归脚本也纳入审阅。

本轮验证使用以下命令记录当前基线：

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check:ai-research-retrieval-pipeline` | 通过 | 检索计划、统计、证据包与 UI 源码合同 |
| `npm run check:ai-research-workflow` | 通过 | AI 研究表、IPC、数据集、报告与工作台源码合同 |
| `npm run check:ai-response-envelope` | 通过 | envelope 构造与元数据持久化 |
| `npm run check:research-integrity` | 通过 | 研究完整性指标的纯函数样本 |
| `npm run test:research` | 通过 | 研究专题、大纲、摘录、快照与删除正常路径 |
| `npm run test:evidence-qa` | 通过 | 单文献/标签 scope 的证据问答正常路径 |
| `npm run test:ai-ui` | 通过 | Markdown、来源链接、流式 API 的源码存在性 |
| `npm run check:ai-evidence-keyword-first` | 通过 | 关键词优先和页面窗口策略源码合同 |
| `npm run check:ai-floating-panel-viewport` | 通过 | AI 浮层视口约束源码合同 |
| `npm run check:ai-library-quick-actions` | 通过 | 分析模板与 scope 列表源码合同 |

这些通过结果只说明旧行为仍存在，不能证明目标成品可靠。多个脚本主要用 `source.includes(...)` 固化实现字符串：进度回归只要求 shared 中存在 `AiResearchRunProgressEvent`，生产代码没有发送该事件，preload 也没有订阅；研究工作流回归把“一次点击自动完成统计、抽取和报告”固定为正确行为，却没有成本、隐私和人工确认门禁；scope 回归把 `LIMIT 500/1000` 当成“完整列表”；完整性回归只检查 locator/hash 非空，不验证能否解析到真实原文。新版验收必须转为行为、故障注入、恢复、资源和真实证据解析测试。

## 3. 当前端到端数据流

### 3.1 凭据与模型配置

```text
SettingsView 输入 LLM / Vision OCR profile
  -> preload settings IPC
  -> settings 表保存 llm_api_key / vision_ocr_api_key
     以及包含 apiKey 的 profile JSON
  -> settings:getAll / profile:list 返回 renderer
  -> ai.ts / vision-ocr.ts 每次调用重新读取当前配置
  -> fetch OpenAI-compatible endpoint
  -> 普通数据库备份复制 settings 与完整密钥
```

`settings` 只有 `key/value` 两列（`src/main/database.ts:519` 至 `src/main/database.ts:522`）。profile 解析和保存明确包含 `apiKey`（`src/main/ipc/settings.ts:453` 至 `src/main/ipc/settings.ts:540`），`settings:getAll` 返回全部设置（`src/main/ipc/settings.ts:633` 至 `src/main/ipc/settings.ts:640`），profile list 又返回包含完整 Key 的 `current/profiles`（`src/main/ipc/settings.ts:728` 至 `src/main/ipc/settings.ts:735`）。共享类型把 `apiKey` 定义为 renderer 可读字段（`src/shared/types.ts:1693` 至 `src/shared/types.ts:1718`）。窗口启用 context isolation、界面使用密码输入框只能降低直接暴露，不能解决 renderer JS、数据库文件和备份均可读取明文的问题。

### 3.2 文献与文库证据问答

```text
AiPanel 输入问题
  -> document / library scope + sessionId + requestId
  -> ai IPC ensureChatSession
  -> 最近 6 轮问答拼入新问题
  -> evidence-qa 生成检索计划
  -> 最多多轮 fullTextSearch
  -> 命中页及前后页窗口
  -> evidence clusters / sources / warnings
  -> callLLMStream
  -> phase / sources / delta / done / error
  -> ai_chat_turns 保存回答与元数据
```

证据问答坚持“先检索、再读取命中页窗口”，避免默认通篇读取，这是正确方向。问题在于 sessionId 只按 ID 复用，不校验 `mode/docId/scope`（`src/main/ipc/ai.ts:243` 至 `src/main/ipc/ai.ts:252`），旧范围的历史回答可被注入新文献或新文件夹问题。流式接口没有取消注册表或外部 AbortSignal；handler 直到检索、模型调用和保存全部结束才返回所谓 start result（`src/main/ipc/ai.ts:578` 至 `src/main/ipc/ai.ts:646`、`src/main/ipc/ai.ts:670` 至 `src/main/ipc/ai.ts:738`）。

stream 失败时会重新执行完整非流式问答并把完整答案继续当作 delta 追加，但最终 response 仍绑定第一次检索的 sources（`src/main/ipc/ai.ts:607` 至 `src/main/ipc/ai.ts:638`、`src/main/ipc/ai.ts:699` 至 `src/main/ipc/ai.ts:730`）。renderer 的 catch 又把当前 history 中所有 `streaming` 项标记失败，而不是只处理对应 requestId（`src/renderer/src/components/AiPanel.tsx:813` 至 `src/renderer/src/components/AiPanel.tsx:864`）。

### 3.3 选中文字、摘要和文献级任务

AiPanel 能显示阅读器传入的 `selectedText`，输入框也提示“围绕选中文字提问”，但 `AiQuestionOptions` 没有该字段，问答请求只发送 question、limit、sessionId 和 requestId（`src/shared/types.ts:2541` 至 `src/shared/types.ts:2546`、`src/renderer/src/components/AiPanel.tsx:774` 至 `src/renderer/src/components/AiPanel.tsx:799`、`src/renderer/src/components/AiPanel.tsx:2059` 至 `src/renderer/src/components/AiPanel.tsx:2078`）。显示范围和实际模型范围不一致。

document 模式的 `hasDocumentText` 只检查是否存在 documentId，不检查正文（`src/renderer/src/components/AiPanel.tsx:669`）。关键词提取等按钮使用阅读器当前传入的约 2200 字 `documentText`，却以文献级任务呈现。后端摘要和综合分析还有独立的页面读取与文献卡片缓存，因此同一文献可能同时存在“当前页附近文本”“inline pages 文本”“搜索 canonical 文本”三种 AI 输入口径。

### 3.4 文库综合分析

```text
选择 all / tags / folders / documents scope
  -> renderer 把 scope 解析为 docIds
  -> synthesizeDocuments(docIds)
  -> 逐文献读取/生成文献卡片
  -> 拼接综合 prompt
  -> LLM 生成 Markdown
  -> 最多 16 条展示来源
  -> 可直接保存 research_output
```

scope 本身是关系定义，但综合分析先在 renderer 把它物化为 ID 数组。all、tag、folder 和“展开完整列表”均静默限制为 1000 篇（`src/renderer/src/components/AiPanel.tsx:926` 至 `src/renderer/src/components/AiPanel.tsx:976`）；研究专题打开 AI 时也一次性传全部项目 docIds。随后文献卡片按文献逐一读取或生成，没有全局 token、API 次数、内存或时间预算。现有 source hash 只使用长度和首尾片段，正文中部发生等长变化时缓存可能不失效；生成来源又只有展示片段 hash，没有稳定 locator（`src/main/ai.ts:319` 至 `src/main/ai.ts:323`、`src/main/ai.ts:1649` 至 `src/main/ai.ts:1693`）。

### 3.5 AI 研究任务

```text
统一输入框 / 研究页输入目标
  -> 关键词规则判断是否自动进入 research
  -> LLM 生成字段和建议检索词
  -> 本地同步检索统计（最多 10 轮 x 8 查询）
  -> 代表证据包（最多 80 条）
  -> statistical: 本地计数记录
     其他类型: 每条 evidence 调 LLM 抽取字段
  -> ai_research_records，默认 pending
  -> 自动或手动生成报告
  -> research_outputs 保存内容与 input snapshot
```

检索和结构化拆分为本地统计与 AI 抽取是正确方向；数量不应由模型编写。当前统计仍在 Electron main 中用同步 SQLite、`LIKE`、多轮聚合和样本读取完成（`src/main/ai-research-retrieval.ts:453` 至 `src/main/ai-research-retrieval.ts:556`、`src/main/ai-research-retrieval.ts:650` 至 `src/main/ai-research-retrieval.ts:697`）。每次 run 先写 `running`，只有成功路径改为 completed；异常不会关闭 retrieval run，也没有启动恢复（`src/main/ai-research-retrieval.ts:847` 至 `src/main/ai-research-retrieval.ts:890`）。

renderer 只要问题包含“统计、多少、提取、表格、时间线”等词就自动进入完整研究流程，并默认自动生成报告（`src/renderer/src/components/AiPanel.tsx:138` 至 `src/renderer/src/components/AiPanel.tsx:142`、`src/renderer/src/components/AiPanel.tsx:1109` 至 `src/renderer/src/components/AiPanel.tsx:1135`）。用户没有机会先确认将发送哪些内容、预计调用次数、证据覆盖、字段方案和是否真的需要报告。

### 3.6 研究专题、摘录、数据集与输出

研究专题聚合文献、摘录、大纲、AI 数据集和报告。若专题存在任何摘录，综合写作只使用摘录；只有完全没有摘录时才回退到项目全部文献（`src/main/ipc/research.ts:511` 至 `src/main/ipc/research.ts:564`）。每篇材料正文只取 2600 字、来源最多 12 条，而 AI 数据报告把整个 Markdown 表静默截为 18,000 字（`src/main/ipc/research.ts:582` 至 `src/main/ipc/research.ts:607`、`src/main/ipc/ai-research.ts:854` 至 `src/main/ipc/ai-research.ts:870`）。这些截断没有 coverage manifest。

AI 记录默认 `pending`，正式报告却只排除 `excluded`，因此未人工确认的记录会直接进入报告（`src/main/ipc/ai-research.ts:628` 至 `src/main/ipc/ai-research.ts:654`、`src/main/ipc/ai-research.ts:854` 至 `src/main/ipc/ai-research.ts:869`）。工作台仅预览前 20 条记录，排除后没有撤销（`src/renderer/src/views/ResearchView.tsx:426` 至 `src/renderer/src/views/ResearchView.tsx:435`、`src/renderer/src/views/ResearchView.tsx:711` 至 `src/renderer/src/views/ResearchView.tsx:719`）。AiPanel 中刚生成的研究报告以 `sources=[]` 渲染，引用无法回跳（`src/renderer/src/components/AiPanel.tsx:1700`）。

## 4. 必须保留的能力

- 文献内问答、文库范围问答、选中文字处理、摘要、标签建议、元数据抽取和跨文献综合分析。
- 关键词优先、先检索后读证据的基本策略；广泛问题不能默认把整库正文一次性发送给模型。
- 文档、文件夹、标签、选中文献和研究专题 scope；古籍与普通 PDF/论文使用同一 scope contract。
- 流式输出、会话历史、来源展示、证据回跳、保存为研究摘录和复制结果。
- AI 研究的计划、字段 schema、本地统计、证据压缩、结构化抽取、人工复核、数据集、报告和导出闭环。
- 本地计数优先于模型估计；模型只能解释已知统计和代表证据，不能伪造完整数量。
- 研究专题、文献集合、树形大纲、摘录、引用、写作输出和完整性检查。
- 当前 OpenAI-compatible 服务商配置与用户可切换 profile；重构后密钥留在 main，并保留旧配置惰性迁移能力。
- 现有 SQLite 数据、旧 chat/session、research note、dataset、record、output 和 snapshot 默认可读；不得为重构要求用户清空数据库。
- 文献、任务、会话、记录和报告总量不设产品上限；只限制当前 claim、并发、游标页、缓存字节、prompt budget 和单次 IPC payload。
- 所有云端 AI 功能继续明确依赖用户配置的服务商；任何新依赖、本地模型或外部服务实施前必须单独获得用户确认。
- 优化成品先提供本地构建和新版验收结果；用户明确确认无问题并批准公开前，不得 push、公开 PR、触发 GitHub Actions 或 Release。

## 5. 关键问题

### D07-P0-01 LLM、视觉 OCR 与 PaddleOCR 凭据明文存储、返回 renderer 并进入普通备份

**证据等级：已确认。**

`settings.value` 直接保存字符串（`src/main/database.ts:519` 至 `src/main/database.ts:522`）。LLM 与视觉 OCR profile 的 JSON 明确包含 `apiKey`，当前 profile 也从 `llm_api_key/vision_ocr_api_key` 读取并原样返回（`src/main/ipc/settings.ts:453` 至 `src/main/ipc/settings.ts:552`）。PaddleOCR 同样直接读取 `paddleocr_api_key`（`src/main/ocr.ts:347` 至 `src/main/ocr.ts:356`）；`settings:getAll` 返回全部设置，Paddle 模型列表 IPC 还可接收 renderer 传来的明文 Token（`src/main/ipc/settings.ts:633` 至 `src/main/ipc/settings.ts:651`）。SettingsView 和 Onboarding 会把三类已保存凭据重新装入 renderer 表单（`src/renderer/src/views/SettingsView.tsx:507` 至 `src/renderer/src/views/SettingsView.tsx:529`、`src/renderer/src/components/OnboardingWizard.tsx:115` 至 `src/renderer/src/components/OnboardingWizard.tsx:132`）。shared/preload 合同也把完整 `apiKey` 暴露为 renderer 数据（`src/shared/types.ts:1693` 至 `src/shared/types.ts:1718`、`src/preload/index.ts:660` 至 `src/preload/index.ts:677`）。普通备份复制数据库，因此三类密钥及历史备份副本都可能长期可读。

**影响：** 任意 renderer XSS、受污染依赖、调试注入、数据库副本或普通备份读取都可能获得可直接使用的云端密钥。密码输入框和 context isolation 不能抵消 renderer API 主动返回明文。该风险同时影响 AI 与云端 OCR，应将模块 03 的同类问题统一提升为 P0。

**落实方案：** 新建 main-only `CredentialVault`，使用 Electron `safeStorage` 加密，并覆盖 `llm_api_key`、`vision_ocr_api_key`、`paddleocr_api_key` 及后续所有标记为 sensitive 的 setting。renderer 在用户输入时不可避免会短暂持有草稿明文，但已保存 secret 不得被任何读取 API 返回；草稿只允许通过专用一次性 `credential:prepare` IPC 提交，main 返回有 TTL 的 opaque draft ref，renderer 随即清空输入。模型列表、连通性测试、保存和 profile 切换只接收 profileId 或 draft ref，不再接收 apiKey。vault 密文写入 `app.getPath('userData')/secrets/credentials.v1` 或等价版本化 sidecar，目录与文件使用当前用户最小权限；SQLite 只保存 `vaultEntryId/version/state` 和公开 profile。跨存储更新执行 `prepare -> 写临时密文并 flush/原子 rename -> SQLite 事务激活引用 -> finalize/清理旧版本`，启动恢复 journal 并回收无引用 entry。旧明文迁移先准备并回读 vault，再在短事务中切换引用和清除旧值；失败保留完整旧状态。迁移备份必须是脱敏数据库副本加已加密 recovery journal，不能再复制一份明文 Key；现有历史备份扫描出 protected key 后，先生成验证过的脱敏替代副本，再由用户明确确认是否隔离或删除原备份。普通备份不携带 sidecar，干净环境恢复后要求重新输入；同机恢复只能复用仍存在且 entry/version 匹配的 vault。可移植加密凭据必须使用独立口令、显式风险提示和单独文件。所有日志、诊断、envelope、IPC 和导出均执行 secret redaction。

### D07-P0-02 远程 HTTP endpoint 可接收明文 Bearer Key，profile 切换也可能形成 Key/URL 混配

**证据等级：已确认。**

配置校验把 `http://` 和 `https://` 同等视为有效协议（`src/shared/config-validation.ts:66` 至 `src/shared/config-validation.ts:70`、`src/shared/config-validation.ts:135` 至 `src/shared/config-validation.ts:147`）。`callLLM` 随后把 Bearer Key 发送到该 URL（`src/main/ai.ts:1037` 至 `src/main/ai.ts:1062`）。profile switch 又按 activeId、provider、baseUrl、apiKey、model 五次独立写 settings，最后才 save（`src/main/ipc/settings.ts:789` 至 `src/main/ipc/settings.ts:800`）；崩溃或异常可留下“新 URL + 旧 Key”等混合状态。

**影响：** 非本机 HTTP endpoint 可在网络中明文泄露 Key；原子性失败还可能把 A 服务商密钥发送给 B endpoint。该问题会造成真实凭据泄露，应与明文存储同列 P0。

**落实方案：** 非 loopback endpoint 强制 HTTPS；`http://127.0.0.1/localhost/[::1]` 仅作为明确的本地模型开发例外，并在 UI 标注“本机未加密连接”。保存和切换 profile 改为单条版本化 profile record 或数据库事务：先验证 URL、解密 secret ref、可选探测 endpoint，再原子激活 `activeProfileId`。执行请求只按 profileId 读取一个冻结快照，不分别读取 baseUrl/key/model 多个 settings key。任何 endpoint host 变化要求重新确认密钥归属，默认不复用旧 secret。

### D07-P1-01 AI 正文读取绕过 canonical content 与外置大字段

**证据等级：已确认。**

`ai.ts` 的页面读取使用 `COALESCE(proofed_text, ocr_text, '')`，既不 hydrate `proofed_text_ref/ocr_text_ref/ocr_result_ref`，也会让空字符串 `proofed_text` 遮蔽有效 OCR（`src/main/ai.ts:301` 至 `src/main/ai.ts:316`）。Evidence QA 和研究专题回退读取同样只查 inline 字段（`src/main/evidence-qa.ts:557` 至 `src/main/evidence-qa.ts:577`、`src/main/ipc/research.ts:546` 至 `src/main/ipc/research.ts:564`）。搜索模块已经能读取外置字段和 active OCR/proof revision，AI 却建立了另一套正文事实。

**影响：** 大字段外置、OCR 版本切换、空校对文本、结构化 OCR 或后续 canonical artifact 激活后，阅读器和检索可看到正文，AI 却判断“没有文本”、读取旧文本或使用不同顺序。摘要、证据、数据集和报告可能基于已经失效的内容。

**落实方案：** AI、摘要、研究、导出和 evidence cluster 全部调用模块 03 拥有的 `CanonicalContentProvider.resolvePage(...) -> CanonicalPageContent`；模块 05 提供 locator/projection，模块 06 只消费 provider。输入 doc/page/sourceKind 和可选 contentVersion，输出 hydrated canonical page/slice、active artifact/revision、稳定 range 和 hash。禁止业务模块直接 `SELECT proofed_text/ocr_text`。旧 inline 页面继续由 provider 兼容读取；外置引用、结构化 OCR、电子书和译文通过同一 adapter 投影。任何缓存、快照和 locator 都绑定 provider 返回的版本，不以字段是否非空自行推断。

### D07-P1-02 选中文字、当前页文本和整篇文献的实际范围与界面承诺不一致

**证据等级：已确认。**

AiPanel 展示 `selectedText` 并提示“围绕选中文字提问”，但 `AiQuestionOptions` 没有 selected range/text，流式请求也没有传递它（`src/shared/types.ts:2541` 至 `src/shared/types.ts:2546`、`src/renderer/src/components/AiPanel.tsx:774` 至 `src/renderer/src/components/AiPanel.tsx:799`、`src/renderer/src/components/AiPanel.tsx:2059` 至 `src/renderer/src/components/AiPanel.tsx:2078`）。document 模式的正文可用判断只检查 documentId（`src/renderer/src/components/AiPanel.tsx:669`）。关键词等非问答任务则直接使用 renderer 传入的有限 `documentText`，却按整篇文献能力展示。

**影响：** 用户以为模型只回答选中文字，实际问题可能在整篇检索范围内回答；用户以为执行文献级关键词/摘要，实际只处理当前页附近文本。无正文文献仍可进入调用并在后端晚失败。范围错觉会直接降低研究结果可信度。

**落实方案：** 所有 AI 入口显式携带 `AiInputScope`：`selection` 必须包含 stable locator、quote、prefix/suffix 和 contentVersion；`page/window/toc-section/document/project/library` 使用稳定 scope ref。main 解析并回显最终有效范围，renderer 只展示 main 确认的 scope label/coverage。选中文字问答先以选择范围为核心，用户可明确切换“仅选中内容/结合所在页/结合全文”。文献级任务不得消费临时 2200 字 prop；必须由 main 从 canonical provider 按任务预算读取。

### D07-P1-03 chat session 不校验文献、模式和文库 scope，旧上下文可串入新范围

**证据等级：已确认。**

只要 sessionId 存在，`ensureChatSession` 就直接返回对应记录，不比较 `mode/doc_id/scope_json`（`src/main/ipc/ai.ts:243` 至 `src/main/ipc/ai.ts:252`）。library session 列表包含全部文库会话，不按 scope 筛选（`src/main/ipc/ai.ts:203` 至 `src/main/ipc/ai.ts:223`），随后最近 6 轮回答被拼入新问题（`src/main/ipc/ai.ts:322` 至 `src/main/ipc/ai.ts:348`）。切换 folder/tag/documents scope 时也不更新或冻结会话身份。

**影响：** 文献 A 的对话可用于文献 B，整个文库的历史可用于一个敏感文件夹，旧 tag scope 的结论可影响新 scope。用户看到当前范围标签，却无法知道模型还读了哪段旧上下文。

**落实方案：** 定义不可变 `ChatSessionIdentity = mode + docId? + normalizedScopeHash + scopeSchemaVersion`。main 对每次请求强校验；身份不同必须新建会话或让用户明确“复制上下文到新范围”。旧 library session 的空 scope 只兼容解释为 `{type:'all'}`，不得自动用于筛选范围。会话历史保存每轮有效 scope snapshot、content/search generation 和 execution context；UI 在切换 scope 时清楚提示会话分叉，不静默复用。

### D07-P1-04 流式请求没有真正 start/cancel 合同，fallback 会造成答案与证据错配

**证据等级：已确认。**

`askDocumentStream/libraryAskStream` 的 IPC handler 完成检索、模型生成和持久化后才 resolve `AiStreamStartResult`；没有 cancel IPC、request registry 或传给 fetch 的外部 AbortSignal（`src/main/ipc/ai.ts:578` 至 `src/main/ipc/ai.ts:738`、`src/main/ai.ts:1102` 至 `src/main/ai.ts:1176`）。流式中途失败时重新运行非流式 evidence QA，并把完整新答案作为 delta 追加；最终 response 却继续使用第一次 evidence pack。若已经收到部分 delta，屏幕还会出现“部分旧答案 + 完整新答案”。

**影响：** 用户无法停止昂贵调用、切换文献后旧任务仍占用网络与主进程；保存历史、屏幕文本和来源可能互不一致。重复文本和错误引用会长期进入研究记录。

**落实方案：** start IPC 只完成参数校验、创建 request/job 并立即返回 accepted；实际工作由 request registry 或统一 scheduler 执行。短请求状态机固定为 `accepted -> retrieving -> generating -> persisting -> completed|error|canceled`，事件携带 requestId、单调 seq、phase、snapshotId。cancel 触发同一个 AbortController 并阻止后续持久化。fallback 必须复用同一冻结 evidence pack；若需要重检索，生成新的 attempt/snapshot，并发送 `replace/reset` 事件而不是 delta 追加。done 中保存的 answer、sources、envelope 必须来自同一 attempt。

### D07-P1-05 renderer 多个异步加载和生成流程缺少 latest-request-wins

**证据等级：已确认。**

scope preview 直接在 effect 中 await 后写 state，没有 generation 或 abort（`src/renderer/src/components/AiPanel.tsx:585` 至 `src/renderer/src/components/AiPanel.tsx:599`）；会话切换也会让较慢旧请求覆盖新会话（`src/renderer/src/components/AiPanel.tsx:732` 至 `src/renderer/src/components/AiPanel.tsx:745`）。研究 planning、preview、run 和 project/dataset/output 切换均没有 request generation。ResearchView 的强制刷新先异步清空 `loadedProjectData`，随后同一闭包仍读取旧值并提前 return（`src/renderer/src/views/ResearchView.tsx:411` 至 `src/renderer/src/views/ResearchView.tsx:442`、`src/renderer/src/views/ResearchView.tsx:547` 至 `src/renderer/src/views/ResearchView.tsx:565`）。

**影响：** 快速切 scope、项目、会话或数据集时，旧结果可能覆盖当前页面；强制刷新可能把列表清空、保留旧数据或显示另一专题内容。这类竞态不会稳定复现，容易被普通测试遗漏。

**落实方案：** 所有 renderer 异步资源使用 `requestGeneration + AbortSignal` 或现有状态库统一 query key；只有 generation 仍匹配当前 identity 时才能 commit state。刷新函数显式传 `force`，不能依赖刚 setState 的闭包值。项目切换先原子更新 project generation，再并行加载带 projectId 的资源；任一旧响应都丢弃。流式事件除 requestId 外还校验 panel/session generation。

### D07-P1-06 `source_hash/locator/envelope` 只检查字段存在，不证明证据真实

**证据等级：已确认。**

Evidence QA 对 `docId + page + snippet` 重新哈希（`src/main/evidence-qa.ts:580` 至 `src/main/evidence-qa.ts:591`）；综合分析和 AI Research 也对展示片段或统计字段生成自己的 hash（`src/main/ai.ts:1679` 至 `src/main/ai.ts:1693`、`src/main/ipc/ai-research.ts:628` 至 `src/main/ipc/ai-research.ts:654`）。研究 IPC 接受 renderer 传来的任意 `source_hash`，没有值时再合成（`src/main/ipc/research.ts:136` 至 `src/main/ipc/research.ts:180`）。非法 locator JSON 会原样保存（`src/shared/research-locator.ts:28` 至 `src/shared/research-locator.ts:41`）。完整性与 envelope 仅统计 locator/hash 是否非空，并据此提高 confidence（`src/shared/research-integrity.ts:71` 附近、`src/shared/ai-response-envelope.ts:67` 至 `src/shared/ai-response-envelope.ts:101`）。

**影响：** renderer 可伪造来源，正文改变后旧摘录仍显示“完整”，错误页或错误片段也会获得较高 confidence。系统把“有一个字符串”误当成“证据经过解析验证”。

**落实方案：** 复用模块 06 `SearchEvidenceResolver` 和模块 03/05 canonical content 合同。main 只接受 `StableReaderLocator` 候选，不接受 renderer 自报 verified/hash；resolver 按 sourceKind、canonical content version、absolute range、quote/prefix/suffix 解析并计算 hash，正交返回 `precision`、`resolution` 与 `verificationStatus`。wire format 统一使用 `exact|block|page|document`、`exact|relocated|unresolved`、`verified|stale|source-missing|legacy-unverified|migration-pending`，不再混用 `legacy_unverified` 或把 page precision 写成状态。旧合成 hash 保留读取但一律标 `legacy-unverified`。integrity、AI envelope、保存摘录、报告和导出只消费 resolver 结果；无法验证时 fail closed，不伪造精确 locator。

### D07-P1-07 AI 缓存与执行元数据不能复现真实模型调用

**证据等级：已确认。**

`ai_results` 的 prompt hash 只包含 sourceText 前 6000 字，保存的 model 固定为 `default`（`src/main/ipc/ai.ts:459` 至 `src/main/ipc/ai.ts:492`）。文献卡片 source hash 只使用页码、长度、首尾 160 字（`src/main/ai.ts:319` 至 `src/main/ai.ts:323`）。callLLM 在每次调用时读取当前 settings；envelope 完成时又重新读取当前 provider/model（`src/main/ai.ts:1037` 至 `src/main/ai.ts:1041`、`src/main/ipc/ai.ts:84` 至 `src/main/ipc/ai.ts:110`）。prompt template、temperature、endpoint fingerprint、检索 generation 和 canonical content version 均未进入缓存键。

**影响：** 文本中段变化、切换模型、修改 endpoint 或更新提示词后可能继续命中旧缓存；长任务中途切 profile，envelope 还可能记录另一个模型。用户无法复现一份报告是如何产生的。

**落实方案：** 请求接受时冻结不含明文密钥的 `AiExecutionContext`：profileId、provider、model、baseUrl fingerprint、参数、prompt template/version、application version、scope/content/search generation、privacy policy 和 budget。缓存键使用完整 canonical content hash 与 context hash，不把正文写入 key。执行中不再读取“当前设置”；envelope、job artifact、dataset 和 output snapshot全部引用冻结 context。prompt 或 resolver 版本变化显式失效缓存，旧缓存仍可显示但标 legacy。

### D07-P1-08 AI Research 不是可恢复、可取消、幂等的任务系统

**证据等级：已确认。**

task/run 表没有 queue、attempt、lease、heartbeat、cursor、pause 或 cancel 字段（`src/main/database.ts:620` 至 `src/main/database.ts:720`）。`runTask` 在 IPC 内同步进入统计和逐条 await 模型抽取（`src/main/ipc/ai-research.ts:555` 至 `src/main/ipc/ai-research.ts:677`）；preload 只能等待完整结果。shared 虽定义 `AiResearchRunProgressEvent`，生产代码没有 emit。retrieval run 只有成功路径更新 completed，启动恢复也不覆盖 AI Research。

**影响：** 应用退出、崩溃、网络中断或系统休眠后任务只能从头重跑；running artifact 永久残留；用户无法暂停或取消。重复点击会创建重复 run，逐条抽取还可能产生重复记录和费用。

**落实方案：** 等待并复用模块 02/03 的唯一 `task_jobs/task_items` scheduler，注册 `ai-synthesis/ai-research/research-report` 等长任务 kind，不再建立第二套 claim/lease。单轮短问答可使用内存 request registry 作为传输 facade，但只保存 AbortController 和 event cursor，不拥有持久任务状态；一旦跨文献、跨批次或需重启恢复，就必须升级为统一 scheduler job。阶段 artifact 为 plan、retrieval snapshot、evidence pack、record batch、report draft；每阶段保存 cursor、attempt、input hash 和 output hash。worker claim 有租约、心跳、并发和 API 速率预算；pause/cancel 在阶段边界和每次模型调用前检查。重启回收过期 lease 并从最后 committed cursor 恢复。相同 task + input snapshot + phase + item key 使用唯一幂等键。

### D07-P1-09 scope 解析、证据搜索和统计在 main 中同步物化大集合

**证据等级：已确认。**

Evidence QA、AI Research 和 retrieval 各自把 tag/folder scope 解析为全部 doc IDs（`src/main/evidence-qa.ts:142` 至 `src/main/evidence-qa.ts:170`、`src/main/ai-research-retrieval.ts:306` 至 `src/main/ai-research-retrieval.ts:343`）。Evidence QA 最多对多个 query 顺序调用同步 `fullTextSearch`（`src/main/evidence-qa.ts:245` 至 `src/main/evidence-qa.ts:296`）；retrieval 最多 10 轮 x 8 查询，每个 query 又做 count、最多 1000 行 sample 和分面计算。全部使用 main 进程的同步 better-sqlite3。

**影响：** 大库、高频短词、复杂 folder/tag scope 会冻结窗口并与 OCR、保存、索引任务争抢 main；内存与 doc ID/候选总量线性增长，违反“总量无限、窗口有界”的产品约束。

**落实方案：** scope 保持 `ScopeRef`/关系谓词，不经 renderer 或 main 物化全部 ID。AI query planner 在只读 worker 中直接 join scope relation，按固定 candidate batch、deadline 和 continuation 执行；main 只管理 job 和小型 envelope。检索、facet、证据 pack、数据集和导出均使用 cursor。并发、单 query 候选、单 evidence pack bytes、prompt tokens、IPC bytes 和缓存 bytes 都由设置和硬上限双重约束；超大任务允许慢，但阅读与保存 event-loop 必须保持可用。

### D07-P1-10 1000 篇、20 条和无分页 API 共同制造“完整结果”错觉

**证据等级：已确认。**

AiPanel 加载范围选项、解析 all/tag/folder scope 和所谓“展开完整列表”都固定 `limit:1000`（`src/renderer/src/components/AiPanel.tsx:560` 至 `src/renderer/src/components/AiPanel.tsx:568`、`src/renderer/src/components/AiPanel.tsx:926` 至 `src/renderer/src/components/AiPanel.tsx:976`）。ResearchView 加文献也只取前 1000 篇（`src/renderer/src/views/ResearchView.tsx:622` 至 `src/renderer/src/views/ResearchView.tsx:627`）。数据集页面只显示前 20 条；task、dataset、project document、note、output、chat session 和旧 ai_results 多数无分页或 cursor，并存在逐项 count 的 N+1（`src/main/ipc/ai-research.ts:259` 至 `src/main/ipc/ai-research.ts:273`、`src/main/ipc/ai.ts:501` 至 `src/main/ipc/ai.ts:503`）。

**影响：** 第 1001 篇以后无法进入综合分析或专题选择，用户却不知道 scope 被截断；20 条以后的记录无法在应用内复核，只能整体复制。库越大，列表响应、N+1 查询和 IPC payload 越不可控。

**落实方案：** 所有集合 API 使用 keyset cursor、稳定排序、total/estimatedTotal、hasMore 和 snapshot/generation；UI 使用搜索式选择器、虚拟列表和增量加载，不把全量选项塞进 Select。scope 由 query relation 表示，选择“全部”不枚举 ID。AI 数据集提供字段筛选、状态筛选、分页复核和批量确认；完整导出走流式文件或分块生成，不通过剪贴板/单次 IPC 返回无界字符串。旧 API 在兼容期保留但标 deprecated，并禁止新调用。

### D07-P1-11 AI Research 统计口径把重叠查询相加，并把样本分面表现为完整事实

**证据等级：已确认。**

多词查询的 `WHERE` 要求所有 terms 同时存在，但 occurrence 只计算 `terms[0]`（`src/main/ai-research-retrieval.ts:466` 至 `src/main/ai-research-retrieval.ts:509`）。`totalDocumentCount/totalPageCount/totalHitCount` 直接累加每个 query stat，同一文献、页和 occurrence 可重复计数（`src/main/ai-research-retrieval.ts:682` 至 `src/main/ai-research-retrieval.ts:696`）。doc type/year/folder/tag/co-occurrence facet 来自最多 1000 条按更新时间排序的 sample（`src/main/ai-research-retrieval.ts:403` 至 `src/main/ai-research-retrieval.ts:450`、`src/main/ai-research-retrieval.ts:525` 至 `src/main/ai-research-retrieval.ts:556`），合同却没有 `exact/sampled/sampleSize/coverage`。

**影响：** UI 的“涉及 N 篇、N 页、N 次”和报告上下文会夸大范围；用户可能把局部样本的年代、类型和共现词分布当成全库精确统计。统计任务是 AI Research 的核心卖点，错误口径属于发布阻断。

**落实方案：** DTO 同时提供 per-query 指标与跨 query 的 canonical union 指标。明确查询语义：AND query 的 `combinationCount`、每个 term occurrence、同页/同段共现距离分别计算，不再用第一个词代替。全局 union 按 canonical hit key/doc/page 去重；facet 每项标 `exact|sampled|estimated`、sampleSize、populationSize、coverage 和 sampling strategy。UI 与报告禁止把 sampled bucket 写成完整分布；需要精确时创建可取消的 aggregate job。

### D07-P1-12 检索词扩展写死特定历史实体并被字符串测试固化

**证据等级：已确认。**

`ai-research-retrieval.ts` 内置“日本、满洲、中国、朝鲜”等 core/alias/related expansion、特定缩写和伪片段规则（`src/main/ai-research-retrieval.ts:59` 至 `src/main/ai-research-retrieval.ts:78`、`src/main/ai-research-retrieval.ts:269` 至 `src/main/ai-research-retrieval.ts:303`）。回归脚本还要求源码中必须存在这些词和 `日满中朝`。它们不是通用中文分词或公开格式规范，而是某类语料的领域词典。

**影响：** 其他古籍、地方志、现代论文、外文资料和不同研究主题会得到偏置扩展；维护者难以判断规则来源和适用范围，也违反开源仓库不写死 corpus-specific keywords 的规范。

**落实方案：** 核心 pipeline 只保留通用 normalization、分词、stop-word 和可解释 query planning。领域别名迁入版本化“项目词表/研究模板词典”，默认空或提供中立示例；用户可查看、启用、禁用和导入导出。AI 建议词先进入 preview，不自动成为统计对象。任何预置词典说明来源、许可证、语言和适用范围；新字典/NER/知识库实施前需用户确认。

### D07-P1-13 AI 检索计划识别了作者、朝代和文献类型，却只实际应用年份

**证据等级：已确认。**

`getExplicitAiFilters` 会提取 `docType/dynasty/yearFrom/yearTo/author`，但 `mergeAiSearchFilters` 只把 yearFrom/yearTo 写入 SearchOptions（`src/main/semantic-search.ts:4021` 至 `src/main/semantic-search.ts:4055`）。同一区段还包含“渡口/偷窃”等语料特定启发式和单字白名单（`src/main/semantic-search.ts:3970` 至 `src/main/semantic-search.ts:3979`、`src/main/semantic-search.ts:4075` 至 `src/main/semantic-search.ts:4096`）。

**影响：** 用户明确要求某作者、朝代或文献类型时，界面可能显示计划已经理解，实际检索仍在更大范围执行；模型随后会根据无关证据回答。古籍朝代筛选和现代论文作者/类型筛选都受影响。

**落实方案：** AI plan 只生成版本化、可展示的 `SearchCriteria`，最终由模块 06 的统一 query AST/filters 执行。每个 inferred filter 都必须标 `explicit|suggested`：用户原句明确出现的可自动应用，模型推断的先让用户确认。执行响应回显 `requestedCriteria/effectiveCriteria/ignoredCriteria`，任何不支持的字段显式警告，不能静默丢弃。删除散落在 semantic-search 中的 corpus-specific heuristic，迁入可配置项目词表。

### D07-P1-14 普通问题会被关键词规则自动升级为完整研究、逐条抽取和报告

**证据等级：已确认。**

统一输入框用正则识别“统计、多少、时间线、表格”等词，只要命中就切换 research 并执行 plan、preview、run、逐条模型抽取和自动报告（`src/renderer/src/components/AiPanel.tsx:138` 至 `src/renderer/src/components/AiPanel.tsx:142`、`src/renderer/src/components/AiPanel.tsx:1109` 至 `src/renderer/src/components/AiPanel.tsx:1213`）。现有回归还把 `autoGenerateReport: true` 当作必须保留行为。流程没有展示实际 scope、预计证据量、模型调用次数、token/费用、发送给外部服务的内容类别，也没有让用户分别关闭抽取或报告。

**影响：** 一个普通问句可能触发多轮检索、最多数十次外部模型调用并自动保存正式产出。用户无法控制成本、隐私范围和产出阶段；误分类时尤其难以理解为什么聊天变成了长任务。

**落实方案：** 正则/分类器只能建议“这可能适合研究模式”，不得直接执行。先显示 main 生成的 `AiOperationPreview`：有效 scope 和文献数、canonical 可读覆盖、查询计划、exact/sampled 指标、证据预算、预计模型调用/token/费用区间、profile revision、endpoint/model/credential version、数据是否离开本机、计划保存的 artifact。用户分别确认“运行检索/抽取记录/生成报告”；可保存默认，但 scope/content/search generation、profile/endpoint/model/credential、计划、披露或预算变化后必须重新确认。普通 QA、快速统计、结构化抽取、完整研究成为明确 segmented mode，不依赖隐式关键词切换。

### D07-P1-15 evidence pack 缺少 canonical hash、覆盖率和 continuation，locator offset 还基于折叠后的文本

**证据等级：已确认。**

`buildSnippet` 先把空白折叠后再计算 charStart/charEnd，offset 不再对应原始 search segment（`src/main/ai-research-retrieval.ts:709` 至 `src/main/ai-research-retrieval.ts:760`）。`AiResearchEvidenceItem` 没有 source hash/content version/resolver status；pack 只有 `truncated:boolean` 和当前 evidence 数（`src/shared/types.ts:2386` 至 `src/shared/types.ts:2412`）。去重键包含 query，同一 segment 可因多个 query 重复进入；score 又加入 `index/1000` 后按降序排序，使较后样本略微优先（`src/main/ai-research-retrieval.ts:725` 至 `src/main/ai-research-retrieval.ts:823`）。

**影响：** 代表证据无法验证是否对应当前原文，也无法说明从多少候选中按何种策略选出；`truncated=true` 没有继续读取方式。UI 和报告只能知道“有 80 条”，不知道覆盖了哪些查询、文献、年代和缺口。

**落实方案：** `EvidencePackV2` 的每项由 resolver 输出 canonical locator/hash/contentVersion/sourceKind/precision；snippet 是展示字段，offset 永远基于 canonical source。pack 保存 population/candidate counts、per-query/per-facet coverage、sampling strategy、budget reason、unresolved count、countsExact 和 continuation。去重使用 canonical evidence ID，不使用 query 或 segment ID；一项可携带多个 matchedQueries。排序函数独立、确定、可测试，tie-breaker 使用 stable ID。pack 不足时报告明确缺口，用户可继续 claim 下一页证据或调整预算。

### D07-P1-16 未确认的 AI 记录默认进入正式报告，超出 prompt 的记录被静默截断

**证据等级：已确认。**

抽取记录默认 `pending`（`src/main/ipc/ai-research.ts:628` 至 `src/main/ipc/ai-research.ts:654`），报告和导出只过滤 `excluded`，因此 pending 与 confirmed 同等使用（`src/main/ipc/ai-research.ts:854` 至 `src/main/ipc/ai-research.ts:869`、`src/main/ipc/ai-research.ts:890` 至 `src/main/ipc/ai-research.ts:915`）。报告 prompt 把 Markdown 表直接 `slice(0, 18000)`；工作台只展示前 20 条记录且没有字段级校正、批量确认或完整翻页。

**影响：** 模型抽取错误可未经人工复核进入研究报告、引用和导出；大数据集后半部分被静默忽略，报告却仍表现为整个数据集的结论。

**落实方案：** 正式报告默认只消费人工 `confirmed` 且 provenance 已验证的记录：evidence provenance 要求 resolver verified，aggregate provenance 要求持久 `ResearchAggregateArtifact` 的 result hash 可解析并保留 generation/exactness/population/sample/coverage。显式“草稿探索”可纳入 pending，但输出带醒目标识、pending 数量和不可引用状态。数据集 UI 提供分页、原文对照、字段编辑、验证规则、批量确认/排除、撤销和审计历史。报告使用分块 map-reduce：每块保存输入 record IDs/hash 和局部摘要，最终合并并生成 cursor 化 input coverage 与 claim/citation manifest；任何未处理记录、超预算块和失败块都写入报告前言及 snapshot，不允许字符串截断。

### D07-P1-17 output snapshot 可由 renderer 伪造，且缺少真实执行模型、证据版本和来源回跳

**证据等级：已确认。**

`research:createOutput` 优先接受 renderer 传入的任意 `input_snapshot_json`，只做 trim，不验证 schema、归属或真实性（`src/main/ipc/research.ts:1024` 至 `src/main/ipc/research.ts:1048`）。snapshot v1 只保存文献元数据和摘录/记录的展示 hash，缺少 canonical content version、search generation、resolver status、实际 evidence pack、provider/model、prompt version、参数、父输出和 output hash（`src/shared/research-output-snapshot.ts:1` 至 `src/shared/research-output-snapshot.ts:64`）。AiPanel 的新报告以空 sources 渲染，无法回跳（`src/renderer/src/components/AiPanel.tsx:1700`）。

**影响：** 一份报告可以带着伪造或不完整的“来源快照”保存；正文、模型或检索变化后无法判断报告是否 stale，也无法从具体结论回到证据。快照存在并不等于可复现。

**落实方案：** output snapshot 只能由 main 从已提交 job artifacts 构造；renderer 只提交 outputId/operation intent，不提交权威快照。`ResearchOutputSnapshotV2` 保存 executionContextId、scope snapshot、evidence pack、record-set manifest、持久 aggregate artifact、input coverage manifest、claim manifest、prompt/template、provider/model、output hash 和 parentVersionId 的 immutable refs。input coverage 逐 record 保存 processed/failed/omitted reason 与 chunk。claim manifest 以 output text range/表格坐标、occurrence、parser/segmentation version 和 hash 唯一定位每个事实句、数字、表格单元或结构化结论，并绑定 canonical evidence 或 aggregate artifact；未知、失效、不属于本次 attempt 或未覆盖的 claim 拒绝进入“正式”状态，并报告 unsupported/stale 数。逐句自动分类和交互式审计仍可作为 P3 增强。AiMarkdown 通过 resolver 回跳。旧 v1 保留读取并标 legacy/unverified；任何归属不匹配拒绝保存。

### D07-P1-18 专题综合在“有任意摘录”和“无摘录”之间静默切换材料，并缺少全局 prompt 预算

**证据等级：已确认。**

专题只要存在一条 note，`getProjectSynthesisTexts` 就完全忽略其余项目文献；没有 note 时才读取所有文献页面（`src/main/ipc/research.ts:511` 至 `src/main/ipc/research.ts:564`）。之后每篇 text 截到 2600 字、source 截到 12 条，所有文献仍一次拼接为 corpus（`src/main/ipc/research.ts:582` 至 `src/main/ipc/research.ts:607`）。跨文献综合的另一条路径又逐文献顺序生成/读取卡片，没有总 API 次数和 token budget（`src/main/ai.ts:560` 至 `src/main/ai.ts:577`）。文档/OCR 内容作为普通 user message 拼接，缺少结构化 untrusted-data 边界和 prompt injection 回归。

**影响：** 专题新增一条摘录后，报告材料范围会突然从全部文献变成摘录子集；大项目可能构造超长 prompt、产生大量调用或被 provider 截断。恶意/偶然出现在文献中的指令性文本还可能干扰模型遵守系统约束。

**落实方案：** 生成前明确选择 `confirmed-notes-only | confirmed-evidence-and-doc-briefs | selected-documents | dataset`，preview 展示覆盖和排除原因。大范围综合进入 scheduler，以稳定 chunk 和预算执行，保存每块 artifact；不在一个 user message 拼全库。文献内容通过结构化 evidence records 传入并明确标记为不可信数据，system prompt 禁止执行材料内指令；输出必须通过 citation/evidence ID 校验。新增 adversarial corpus 测试，验证材料中的“忽略规则/编造引用/输出密钥”等指令不能改变来源和保存合同。

### D07-P1-19 研究大纲、摘录和项目关系缺少同项目校验、无环约束和事务删除

**证据等级：已确认。**

大纲更新/移动可把 parent 设为任意 ID，后端不验证同项目、也不检查祖先环（`src/main/ipc/research.ts:764` 至 `src/main/ipc/research.ts:814`）。UI 只从上级选项中排除节点自身，不排除子孙（`src/renderer/src/views/ResearchView.tsx:1339` 至 `src/renderer/src/views/ResearchView.tsx:1346`）；导出递归没有 visited guard，环可导致无限递归/栈溢出。批量把摘录归入大纲也不校验 note 与 outline 是否同项目（`src/main/ipc/research.ts:944` 至 `src/main/ipc/research.ts:952`）。删除节点只先解除直接关联摘录，随后 `research_outline_items.parent_id` 的 `ON DELETE CASCADE` 会递归删除整棵子树；后代摘录再由外键变成未归类，用户没有影响预览或恢复入口（`src/main/database.ts:566` 至 `src/main/database.ts:581`、`src/main/ipc/research.ts:797` 至 `src/main/ipc/research.ts:805`）。删除项目由多条独立 DELETE 组成，无事务，AI task/dataset/record 的 SET NULL/保留语义也没有产品定义（`src/main/ipc/research.ts:730` 至 `src/main/ipc/research.ts:737`）。

**影响：** 用户可制造循环、跨专题引用、不可见子树和部分删除；导出可能使 Electron main 崩溃。AI 数据在删除专题后可能成为无法从 UI 找回的孤立记录。

**落实方案：** main 提供统一 ResearchRepository，在事务中验证 project ownership、parent existence 和 acyclic tree；数据库增加必要唯一/检查索引，递归读取仍保留 visited/depth guard。删除节点必须让用户选择“提升子节点/递归删除/取消”，默认提升且保留摘录。删除专题优先改为归档；永久删除先生成影响预览和自动备份，在单事务中处理 documents relation、notes、outline、outputs、tasks/datasets/records，并明确保留或删除策略。跨项目移动使用显式 command 和审计记录，不允许普通 update 偷换归属。

### D07-P1-20 任务、步骤、retrieval run 和记录缺少数据库级幂等唯一约束

**证据等级：已确认。**

`ai_research_task_steps` 只有普通 `(task_id, step_key)` 索引，upsert 先查后写；`ai_research_records` 也先查 `(dataset_id, source_hash)` 后在一次 `await callLLM` 之后插入，表上没有唯一约束（`src/main/database.ts:637` 至 `src/main/database.ts:683`、`src/main/ipc/ai-research.ts:628` 至 `src/main/ipc/ai-research.ts:654`）。同一 task 可以重复运行并创建多个 retrieval run；当前单 main 进程下通常会复用 dataset_id，但重复 retrieval、抽取调用和并发 record 插入仍可发生。

**影响：** 双击、重试、恢复或未来 worker 并发会产生重复步骤、run、记录和模型费用。应用层“先查后写”无法作为并发保证。

**落实方案：** 为 job attempt/phase/item 定义稳定 idempotency key。数据库 additive 增加唯一索引，例如 `(job_id, attempt, phase, item_key)`；record 使用 `(dataset_id, provenance_key, schema_version, extraction_version)`，其中 provenance_key 来自 canonical evidence ID 或 aggregate snapshot/result hash，而不是脆弱 snippet hash。步骤用 `INSERT ... ON CONFLICT DO UPDATE`。迁移前扫描重复行并生成报告，不直接丢数据；自动备份后在事务中选择 canonical row，把其他行标 duplicate/merged，失败回滚。所有重试先复用 committed artifact；远端 outcome 未知时按 `remote-outcome-unknown` 停止，不能承诺所有 provider 都不重复计费。

### D07-P1-21 retrieval run、stats 与 evidence pack 非事务写入，读取时还可能跨 run 混配

**证据等级：已确认。**

持久化先把 run 更新 completed，再分别插入 stats 和 evidence pack，三步没有事务；任一步失败都会留下不完整 artifact（`src/main/ai-research-retrieval.ts:860` 至 `src/main/ai-research-retrieval.ts:875`）。读取“最新统计”和“最新证据包”又分别按 taskId/created_at 查询，不要求相同 runId（`src/main/ai-research-retrieval.ts:893` 至 `src/main/ai-research-retrieval.ts:906`）。时间相同或部分失败后，报告可能组合不同 attempt 的统计与证据。

**影响：** UI、报告和恢复逻辑会把 A 轮统计配给 B 轮证据，或把只有 stats 没有 pack 的 run 当完成；来源覆盖和计数无法再复现。

**落实方案：** 一个 attempt 的 plan、stats、pack 和完成状态在短事务中原子提交；大 JSON 先作为 staging artifact 写入并校验 hash，再由事务激活。task 保存 `active_completed_run_id`，所有读取以该 runId join，禁止分别取 latest。失败 run 标 `error/canceled` 并保留错误与阶段，不能 completed。清理只删除未被 output/dataset 引用且超过保留期的 staging artifact。

### D07-P1-22 大型旧库会永久跳过 research locator 回填和新增索引

**证据等级：已确认。**

兼容迁移立即添加 `research_notes.locator_json` 等列，但旧 `source_id -> locator_json` 回填位于 `normalizeExistingData`（`src/main/database.ts:1642` 至 `src/main/database.ts:1650`、`src/main/database.ts:1820` 至 `src/main/database.ts:1835`）。已有数据库的新索引也只在 deferred maintenance 中创建；大型文库在调用 normalize/ensureIndexes 前直接 return（`src/main/database.ts:2101` 至 `src/main/database.ts:2109`、`src/main/database.ts:2118` 至 `src/main/database.ts:2134`）。研究 snapshot 和 integrity 直接读取 locator_json，因此大型旧库的历史摘录会长期显示缺 locator。

**影响：** 最需要有界迁移的大库反而永远不完成兼容升级；AI/研究列表性能缺索引，历史摘录 lineage 不完整，且每次启动只重复记录“已跳过”。

**落实方案：** 将“必须完成的轻量 schema/index/backfill”与可选 VACUUM/FTS/重统计分离。索引使用 `CREATE INDEX IF NOT EXISTS` 的可恢复后台 job；backfill 按主键 cursor 小批事务执行，保存 migrationId、cursor、rowsDone、heartbeat，可暂停但不会永久跳过。启动只 claim 小批，阅读优先；用户设置页可查看进度和失败原因。迁移前自动备份，重复执行幂等，旧客户端仍可读取未回填行；完整性 UI 将未迁移与真实 unresolved 区分。

### D07-P1-23 对话、大纲、摘录和记录排除缺少确认、撤销与恢复入口

**证据等级：已确认。**

AiPanel 点击删除图标立即删除当前会话（`src/renderer/src/components/AiPanel.tsx:747` 至 `src/renderer/src/components/AiPanel.tsx:772`、`src/renderer/src/components/AiPanel.tsx:1782` 至 `src/renderer/src/components/AiPanel.tsx:1786`）。ResearchView 删除大纲、摘录和排除记录也直接执行，没有影响预览、undo token 或回收站（`src/renderer/src/views/ResearchView.tsx:615` 至 `src/renderer/src/views/ResearchView.tsx:666`、`src/renderer/src/views/ResearchView.tsx:716` 至 `src/renderer/src/views/ResearchView.tsx:719`）。其中大纲删除还会因级联约束永久删除整棵子树，属于真实数据丢失风险，不能留在普通易用性 P2。

**影响：** 误点会永久丢失对话、摘录或大纲子树，或让数据记录从正式结果中消失；图标位于密集列表时风险更高，且当前备份/恢复粒度不能充当即时撤销。

**落实方案：** 轻量排除使用可撤销 soft state，toast 提供撤销；会话、摘录、大纲和项目先进入回收站/归档，显示影响数量并可恢复。永久删除只在回收站二次确认。后端 command 返回 operationId/undoUntil，保证 UI 撤销不是本地假状态。键盘触发和读屏确认流程与鼠标一致。大纲表需要把 parent 删除语义从级联改为显式 command：默认提升子节点，递归删除必须单独确认并在事务中执行；迁移时重建外键前先盘点和备份。

### D07-P2-01 两类“confidence”都不是校准概率，却以精确百分比呈现

**证据等级：已确认。**

AI 抽取直接接受模型自报 confidence，缺失时默认 0.65，失败 fallback 固定 0.45（`src/main/ipc/ai-research.ts:529` 至 `src/main/ipc/ai-research.ts:552`）；ResearchView 将其显示为“置信度 N%”（`src/renderer/src/views/ResearchView.tsx:1228` 至 `src/renderer/src/views/ResearchView.tsx:1234`）。`AiResponseEnvelope.confidence` 则按来源数量、字段非空比例和 warning 数启发式计算（`src/shared/ai-response-envelope.ts:93` 至 `src/shared/ai-response-envelope.ts:101`）。两者都没有校准数据集。

**影响：** 用户会把 65%、98% 理解为可比较的正确概率，掩盖来源伪造、coverage 不足和模型自信但错误的问题。

**落实方案：** 拆成 `modelSelfScore`、`evidenceCoverage`、`resolverVerification` 和 `humanReviewStatus`。未经按任务/语言/文献类型校准的值不显示百分比，只显示“模型自评：低/中/高（不可视为正确率）”。若未来需要概率，必须用独立标注集分别报告古籍与普通论文 calibration/accuracy，并记录模型版本；人工 confirmed 永远单独显示，不能由模型分数替代。

### D07-P2-02 研究输出只有创建、列表、读取和复制，没有编辑、归档、删除或版本关系

**证据等级：已确认。**

research IPC 只暴露 create/list/get，ResearchView 只展示最近 5 份并复制完整内容（`src/main/ipc/research.ts:1024` 至 `src/main/ipc/research.ts:1077`、`src/renderer/src/views/ResearchView.tsx:1262` 至 `src/renderer/src/views/ResearchView.tsx:1291`）。`research_outputs` 没有 updated_at、status、parent_version_id 或 title/content 编辑历史。

**影响：** 用户无法修订 AI 草稿、比较版本、归档过时报告或删除错误产出；重新生成只会堆积无法管理的记录。

**落实方案：** 输出采用不可变版本 + 可变元数据：编辑/重新生成创建新 version，保留 parent 和 snapshot；title/status 可事务更新。列表支持 active/archived/stale、搜索和分页；删除走回收站。默认展示最新版本，但引用旧版本的导出仍可读取。第一阶段可 additive 增加 output metadata/version 表，旧 row 惰性包装为 version 1。

### D07-P2-03 研究摘录去重不包含 projectId，同一证据无法服务两个独立专题

**证据等级：已确认。**

`findDuplicateNote` 只按 doc_id + source_hash 或 doc_id + excerpt 查重，没有 project_id（`src/main/ipc/research.ts:475` 至 `src/main/ipc/research.ts:499`）。同一原文在专题 A 保存后，专题 B 再保存会被当作重复。

**影响：** 同一史料或论文段落本可支持不同研究问题，却被全局去重阻止；用户只能复制改字或失去专题归属。

**落实方案：** note identity 至少包含 `projectId + canonicalEvidenceId + kind`；无项目的 inbox 使用独立 namespace。若用户确实重复保存同一证据，UI 可提示“引用已有证据到本专题”，通过 relation 复用 evidence，而不是复制正文或拒绝。旧 note 保持可读，迁移只新增 relation/唯一约束，不合并不同研究备注。

### D07-P2-04 “原文可用”只验证页面存在，界面没有 verified/stale/unresolved 细分

**证据等级：已确认。**

`source_available` 只检查相同 doc/page 是否存在，不比较 locator、quote 或 hash（`src/main/ipc/research.ts:351` 至 `src/main/ipc/research.ts:367`）。ResearchView 只显示“原文待恢复”或默认正常（`src/renderer/src/views/ResearchView.tsx:798` 至 `src/renderer/src/views/ResearchView.tsx:829`、`src/renderer/src/views/ResearchView.tsx:1032`）。

**影响：** 页存在但正文已改、locator 已失效的摘录仍看起来可信；用户也无法区分旧版未迁移、来源删除和精确范围解析失败。

**落实方案：** 列表和报告分别显示 `precision`、`resolution` 和 `verificationStatus`：page 是定位精度，unresolved 是解析结果，stale/source-missing/legacy-unverified/migration-pending 是验证状态，不能混成一个枚举。点击状态可查看内容版本、验证时间、失败原因和修复动作。批量完整性检查进入低优先级 job，不在每次列表请求同步扫描全库。

### D07-P2-05 状态类型允许任意字符串，IPC 更新也缺少运行时白名单

**证据等级：已确认。**

`AiResearchTaskStatus/StepStatus/RecordStatus` 均包含 `(string & {})`，renderer update payload 可提交任意 status；`updateRecord` 直接保存（`src/shared/types.ts:318` 至 `src/shared/types.ts:324`、`src/main/ipc/ai-research.ts:717` 至 `src/main/ipc/ai-research.ts:727`）。

**影响：** 拼写错误或旧/新版本混用会产生 UI 不认识的状态；报告当前只排除 `excluded`，未知状态仍会进入正式输出。

**落实方案：** shared 使用闭合版本化状态枚举，main 对每个 command 做运行时校验和合法状态转换；扩展状态通过 schemaVersion 升级，不用开放 string。非法或旧值在兼容 adapter 中映射为 `unknown-legacy`，不把该值写入正常 `ResearchReviewStatus`；此类记录禁止进入正式报告，不能静默当 pending/confirmed。

### D07-P2-06 关键回归大量依赖源码字符串，真实 Evidence QA 和 AI UI 又未进入默认测试

**证据等级：已确认。**

AI research workflow/retrieval、quick actions、floating viewport、keyword-first 和 Markdown QA 主要读取源码并断言 `includes`。`research-regression` 不注册 `ai-research.ts`，没有运行任何 `aiResearch:*` IPC；migration 只用新数据库。`npm test` 等于 `npm run check`，当前未包含 `test:evidence-qa` 和 `test:ai-ui`，尽管二者单独运行已通过。

**影响：** 取消、崩溃恢复、并发、密钥脱敏、旧库迁移、source mutation、SSE 损坏和大数据集边界均可在 CI 中完全失效而仍显示绿灯。

**落实方案：** 保留少量架构静态门禁，但把行为要求移入 Electron/native SQLite 集成和 renderer 测试。默认 `npm test` 纳入 evidence QA、secret redaction、legacy migration、AI Research failure-injection 和关键 UI 行为；大型性能/Windows 打包测试分层运行。源码字符串只检查禁止依赖或公开 API 名，不能证明业务正确。

### D07-P2-07 AI/研究关键状态和图标操作缺少完整键盘与读屏语义

**证据等级：已确认。**

流式 phase/progress 主要通过普通文本和 message toast 更新，没有 `aria-live`；研究大纲在一个大 button 内嵌带 onClick 的 Edit/Delete icon，图标本身不是独立可聚焦按钮（`src/renderer/src/views/ResearchView.tsx:1099` 至 `src/renderer/src/views/ResearchView.tsx:1118`）。多个纯图标按钮依赖 hover Tooltip，异步 source/record 状态没有稳定的读屏名称。

**影响：** 键盘用户难以单独编辑/删除大纲，读屏用户无法连续获知检索、生成、取消、失败和证据状态；研究工作台的密集操作容易误触。

**落实方案：** 所有命令使用真实 Button/icon+tooltip/aria-label，树节点采用可访问 tree/treeitem 或经过验证的组件；状态区使用节流的 polite live region，错误/确认使用 assertive dialog。流式 token 不逐字播报，只播 phase 和完成摘要。定义焦点返回规则、Esc 取消、Tab 顺序和快捷键冲突测试，并用 NVDA + 全键盘人工 smoke 验收。

### D07-P2-08 研究首页统计在 main 中全量读取 documents 再由 JavaScript 计数

**证据等级：已确认。**

`research:getDashboard` 为计算引用缺失数执行 `SELECT author, metadata FROM documents`，再在 main 中逐条 JSON parse/filter（`src/main/ipc/research.ts:1116` 至 `src/main/ipc/research.ts:1145`）。

**影响：** 文库增长后，打开研究页会产生与全库文献数线性相关的同步读取和对象分配；这与页面只需几个统计数字的目标不匹配。

**落实方案：** 可 SQL 计算的状态用索引友好的聚合；复杂元数据完整性由低优先级 health job 增量维护计数和 generation，dashboard 只读小型快照。数据变化通过事务事件 bump 相关统计，不在每次进入页面全库扫描。统计若过期需显示 checkedAt/stale，而不是阻塞页面等待精确重算。

## 6. 目标架构与兼容策略

```text
Public Provider Profile
  -> main-only CredentialVault
     -> journaled, crash-recoverable profile activation
     -> frozen AiExecutionContext (never contains plaintext secret)

AiOperationIntent
  -> resolve AiInputScope / ScopeRef
  -> CanonicalContentProvider.resolvePage -> CanonicalPageContent + SearchSnapshot
  -> AiOperationPreview (coverage, provider, budget, disclosure)
  -> explicit user confirmation when required
  -> shared task scheduler: AiJob / attempt / phase / lease / cursor
     -> retrieval worker
        -> SearchEvidenceResolver
        -> EvidencePackV2 + coverage + continuation
     -> model gateway with AbortSignal and bounded concurrency
     -> extraction artifacts
     -> human review dataset
     -> versioned ResearchOutput + lineage

Renderer
  <- secret-free profiles
  <- accepted job id
  <- sequenced progress events / cursor pages
  <- precision / resolution / verification states
  <- cancel / pause / resume / retry commands
```

核心原则：

- renderer 可以表达意图、显示状态和提交人工判断，但不能生成权威 source hash、snapshot、execution context 或 secret-bearing profile。
- 已保存 API Key 只在 main 的 vault 解密，并只在实际网络请求构造 Authorization header 的最短作用域内存在；不写日志、不通过读取 IPC 返回、不进普通备份。唯一例外是用户当前输入草稿经专用 one-way prepare IPC 提交后立即清空。
- 一次模型调用开始前冻结 provider、model、endpoint、credential entry/version、参数、prompt、scope、内容版本、搜索 generation、预算和隐私策略；执行中切设置只影响后续任务。
- 一个研究结论必须能追溯到同一 attempt 的 evidence pack、record versions 和 execution context；不能把两个 run 的统计、证据和回答拼成一份结果。
- 搜索、AI、研究摘录、引用、导出和阅读器共用 canonical evidence identity。snippet、segmentId、pageNum 和模型 confidence 都不是证据身份。
- 文献和任务总量不设产品上限；scope 用关系表示，所有列表、查询、artifact、prompt、IPC 和缓存都有游标、字节、token、deadline 与并发预算。
- AI 自动产出默认是候选。只有人工 confirmed 且 evidence/aggregate provenance 已验证的记录才能进入“正式/可引用”报告；探索草稿必须显式标注。
- 任务、迁移和删除均可恢复、幂等、可审计。任何优化不得以清空旧库、丢失研究记录或重做全部 OCR 为前提。

### 6.1 凭据与执行上下文合同

建议 renderer-facing profile 改为：

```ts
interface PublicProviderProfile {
  id: string
  revision: number
  name: string
  provider: string
  baseUrl: string
  model: string
  transport: 'https' | 'loopback-http'
  secret: {
    configured: boolean
    credentialVersion?: number
    last4?: string
    updatedAt?: string
  }
  updatedAt: string
}

interface CredentialDraftInput {
  profileId?: string
  value: string
  purpose: 'llm' | 'vision-ocr' | 'paddle-ocr'
}

type SecretMutation =
  | { action: 'retain' }
  | { action: 'replace'; draftCredentialRef: string }
  | { action: 'clear' }

interface AiExecutionContextSnapshot {
  id: string
  previewId: string
  previewContextHash: string
  profileId: string
  profileRevision: number
  credentialEntryId: string
  credentialVersion: number
  credentialLeaseKind: 'ephemeral-request' | 'durable-job-pin'
  provider: string
  model: string
  endpointFingerprint: string
  transport: 'https' | 'loopback-http'
  parameterHash: string
  promptVersion: string
  appVersion: string
  scopeHash: string
  contentGeneration?: string
  searchGeneration?: string
  queryPlan: ImmutableArtifactRef
  confirmedArtifactKinds: string[]
  budget: AiBudget
  disclosurePolicy: 'remote-content' | 'local-only'
  disclosureHash: string
  createdAt: string
}
```

`CredentialDraftInput.value` 是唯一允许经过 renderer 的明文路径，只能来自用户当前输入，不能由读取 API、表单初始化、日志、错误或 state 持久化产生。main 接收后立即写 prepared vault entry、返回 TTL draft ref；renderer 清空字段，模型列表与测试只使用该 ref。取消、超时或未激活 draft 由 journal 回收。

`AiExecutionContextSnapshot` 不保存 Key，但必须冻结 `credentialEntryId + credentialVersion`，不能只冻结 profileId。model gateway 只解密该版本并校验 endpoint fingerprint；同 profile、同 host 轮换 Key 后，旧排队任务继续使用被引用的旧版本，或在版本已明确撤销时以共享任务状态 `paused` 加 `blockedReason='credential-required'` 停止，不能悄悄换账户。只有 queued/running/paused 且可继续执行的 durable job 可以持久 pin 密文；任务终结后，output/run lineage 只保留不可解密的 credential version tombstone、provider/model 和 endpoint fingerprint，不阻止 clear/revoke/profile 删除后的 ciphertext GC。短 request 不写持久 pin：consume 时在 main 内解密为绑定 requestId/attemptId 的不可序列化 `EphemeralCredentialLease`，只存内存并在 completed/error/canceled/timeout 的 finally 中移除所有应用可控引用；可变 Buffer 做 best-effort zeroize，secret 禁止序列化、日志、IPC、state 持久化或缓存。Electron/JavaScript 不承诺能够验证引擎字符串和网络栈内部副本清零。进程崩溃后 lease 不可恢复或重放。clear/revoke 阻止新 lease，但已 accepted 的短 request 使用冻结内存凭据完成或被用户 cancel，不再读取 sidecar。generic `settings:get/set/getAll` 必须对 protected key 拒绝或脱敏，所有 profile mutation 使用专门 command。

vault sidecar 每个 entry 至少保存 `entryId/version/state/preparedAt/ciphertextHash/ciphertext`，journal 保存待激活 profile、旧/新 entry 和阶段。写入顺序固定为：准备密文临时文件并 flush、原子 rename sidecar、在 SQLite 短事务中激活公开 profile 引用、标记 journal finalized、延迟 GC 旧 entry。崩溃恢复只允许回到完整旧引用或完整新引用；SQLite 事务不被描述成可原子提交外部文件。Windows 安装版、便携版、同机不同用户、移动目录、sidecar 丢失、数据库恢复、profile 删除和卸载均进入故障矩阵。

### 6.2 输入范围、scope 与证据合同

```ts
type AiInputScope =
  | { type: 'selection'; locator: StableReaderLocator }
  | { type: 'page'; locator: StableReaderLocator }
  | { type: 'toc-section'; docId: string; tocId: string }
  | { type: 'document'; docId: string }
  | { type: 'library'; scopeRef: LibraryScopeRef }
  | { type: 'project'; projectId: string; sourceMode: ResearchSourceMode }
  | { type: 'dataset'; datasetId: string; recordFilter: ResearchRecordFilter }

interface CanonicalEvidenceRefV2 {
  id: string
  sourceKind: 'source' | 'translation' | 'ebook' | 'research-note'
  locator: StableReaderLocator
  precision: 'exact' | 'block' | 'page' | 'document'
  resolution: 'exact' | 'relocated' | 'unresolved'
  verificationStatus: 'verified' | 'stale' | 'source-missing' | 'legacy-unverified' | 'migration-pending'
  resolvedText?: string
  matchedQueries?: string[]
}

interface EvidencePackV2 {
  id: string
  attemptId: string
  scopeSnapshotId: string
  searchSnapshotId?: string
  evidence: CanonicalEvidenceRefV2[]
  coverage: {
    populationDocuments?: number
    candidateDocuments: number
    representedDocuments: number
    candidateEvidence: number
    includedEvidence: number
    exactness: 'exact' | 'sampled' | 'estimated'
    sampleStrategy?: string
    unresolved: number
    omittedByBudget: number
  }
  continuation?: string
  createdAt: string
}
```

`CanonicalContentProvider.resolvePage(...) -> CanonicalPageContent` 是唯一页面内容关系：模块 03 负责 active proof/OCR/source 选择和 `CanonicalPageContent`，模块 05 负责 `StableReaderLocator` 与投影，模块 06 的 `SearchEvidenceResolver` 只消费二者并返回上述正交状态。`CanonicalEvidenceRefV2` 不重复保存 locator 已有的 documentId、sourceHash、contentVersion、offsetUnit、quote、prefix 或 suffix；main 返回的 normalized locator 是这些身份字段的唯一权威值，展示文本只是派生值。

状态组合也必须受运行时校验：`verificationStatus='verified'` 只能配 `resolution='exact|relocated'`，`resolution='unresolved'` 不能进入正式引用；`source-missing` 不返回 resolvedText；`legacy-unverified/migration-pending` 不能被 UI 或导出提升为 verified。precision 只描述定位粒度，不代表内容已经验证。

`LibraryScopeRef` 保存 all/tag/folder/document relation 和组合语义，不保存前 1000 个 docIds。main 生成 normalized scope hash，并在 search worker 中直接 join。selection 先由 resolver 校验；失效时 UI 让用户重新选择或降级到 page，不自动改成整篇。Evidence pack 可以 sampled，但必须说清 population、coverage 和 continuation；正式引用只允许 `verificationStatus='verified'` 且 precision 满足引用要求的 evidence，page precision 必须明确显示。

### 6.3 操作预览、任务状态与事件合同

```ts
interface AiOperationPreview {
  previewId: string
  contextHash: string
  expiresAt: string
  intent: 'qa' | 'quick-stat' | 'extract' | 'synthesize' | 'research'
  effectiveScope: AiInputScope
  scopeHash: string
  contentGeneration?: string
  searchGeneration?: string
  scopeSummary: {
    documentCount?: number
    readableCount?: number
    countsExactness: 'exact' | 'sampled' | 'estimated'
    coverageStatus: string
  }
  provider: Pick<PublicProviderProfile, 'id' | 'revision' | 'name' | 'model' | 'transport'>
  endpointFingerprint: string
  credentialEntryId: string
  credentialVersion: number
  disclosure: { leavesDevice: boolean; payloadKinds: string[] }
  budget: AiBudget
  estimate: { callsMin: number; callsMax: number; tokensMin?: number; tokensMax?: number; costText?: string }
  promptVersion: string
  queryPlan: ImmutableArtifactRef
  planSummary: string[]
  artifacts: string[]
  confirmationRequired: boolean
}

type AiJobPhase = 'planning' | 'retrieving' | 'packing' | 'generating' | 'extracting' | 'review-ready' | 'reporting' | 'persisting'

interface AiJobProgressEvent {
  operationId: string
  jobId: string
  attemptId: string
  seq: number
  taskState: Omit<TaskStateEnvelope, 'phase' | 'blockedReason'> & {
    phase: AiJobPhase
    blockedReason?: 'credential-required' | 'budget-exceeded' | 'preview-stale' | 'user-review-required'
    recoveryAction?: string
  }
  completedUnits: number
  totalUnits?: number
  progress?: number
  message: string
  artifactId?: string
  occurredAt: string
}

interface AiRequestProgressEvent {
  operationId: string
  requestId: string
  attemptId: string
  seq: number
  phase: 'retrieving' | 'generating' | 'persisting'
  status: 'accepted' | 'streaming' | 'completed' | 'error' | 'canceled'
  message?: string
  occurredAt: string
}

type AiOperationStartResult =
  | { execution: 'request'; operationId: string; requestId: string; attemptId: string }
  | { execution: 'job'; operationId: string; jobId: string; attemptId: string }
```

`AiJobProgressEvent.taskState` 直接复用模块 01 的 `TaskStateEnvelope` 和闭合 `TaskStatus=queued|running|paused|completed|error|canceled`，不为 AI 再定义终态；credential、预算和人工复核使用 `paused + blockedReason/recoveryAction`，过渡中的 pausing/canceling 只是 commandState，partial 只能是 `completed + completionKind='partial'`。短问答使用独立 `AiRequestProgressEvent`，不伪造 jobId；短 request 与 durable job 共用 operationId/attemptId、错误 envelope 和 lineage，但只有 job 持久化 TaskStatus/lease/cursor。

preview 是 main 持有的不可变、一次性消费 artifact；contextHash 必须绑定 scope/content/search generation、profileId/profile revision、endpoint fingerprint、model、credentialEntryId/version、query plan、披露范围、预算、prompt 和预计 artifact。start command 提交 previewId/contextHash；任何绑定项变化、过期或 draft credential 失效都返回 `preview-stale` 并重新确认。profile mutation、clear/revoke 与 preview consume 共用 CredentialVault coordinator lock；在锁内重新读取 revision/generation 和 sidecar entry。durable job 以一个 SQLite 短事务完成“标记 preview consumed、写入冻结 execution context、创建 job、登记 credential pin”；短 request 则先建立绑定 requestId/attemptId 的 `EphemeralCredentialLease`，再在同一临界区标记 preview consumed、写 context 并注册 request，任一步失败都从 registry 移除、释放应用可控引用并对可变 Buffer 做 best-effort zeroize。锁释放且 job pin 或 request lease 成功后才允许 retrieval/provider 调用或 artifact 写入，clear/revoke 不能插入检查与凭据冻结之间。main 同时根据 scope、预算和计划确定 `execution='request|job'`，返回唯一 start result；执行开始后不得无副作用证明不足地从 request 半途升级 job。事件 seq 必须单调；renderer 重连时用 `afterSeq` 补 job 事件，不能依赖易丢失的 toast。cancel/pause/resume/retry 都是幂等 command。模型 stream 使用 requestId + seq；fallback 只能创建新 attempt 或 replace event。job 的 progress 由 committed units 计算，不靠 UI 猜测。

### 6.4 数据集人工复核与输出 lineage

```ts
type ResearchReviewStatus = 'pending' | 'confirmed' | 'excluded' | 'needs-review'

interface ImmutableArtifactRef {
  id: string
  hash: string
}

type ResearchProvenanceRef =
  | { type: 'evidence'; evidenceId: string }
  | { type: 'aggregate'; aggregateArtifactId: string; resultHash: string }

// ResearchAggregateArtifact 直接导入模块 06 的 shared DTO；模块 07 不重复定义 wire format。

interface ResearchRecordVersionV2 {
  id: string
  recordId: string
  version: number
  datasetId: string
  provenance: ResearchProvenanceRef[]
  schemaVersion: string
  extractionVersion: string
  values: Record<string, string>
  modelSelfScore?: number
  reviewStatus: ResearchReviewStatus
  provenanceStatus: 'verified' | 'needs-review' | 'unverified'
  reviewedAt?: string
  createdAt: string
}

type ResearchClaimLocation =
  | { kind: 'text'; start: number; end: number; occurrence: number; offsetUnit: 'utf16-code-unit-v1'; normalizationVersion: string }
  | { kind: 'table-cell'; tableId: string; rowIndex: number; columnIndex: number; jsonPointer?: string }

interface ResearchClaimManifestEntry {
  claimId: string
  outputVersionId: string
  parserVersion: string
  segmentationVersion: string
  location: ResearchClaimLocation
  textOrCellHash: string
  provenance: ResearchProvenanceRef[]
  supportStatus: 'supported' | 'unsupported' | 'stale'
}

type ResearchInputCoverageUnit =
  | { kind: 'record-version'; recordVersionId: string }
  | { kind: 'evidence'; evidenceId: string; evidenceHash: string }
  | { kind: 'aggregate'; aggregateArtifactId: string; resultHash: string }
  | { kind: 'project-note'; noteVersionId: string; contentHash: string }
  | { kind: 'document-brief'; documentId: string; briefHash: string; contentVersion?: string }
  | { kind: 'document-chunk'; locator: StableReaderLocator; contentHash: string }

interface ResearchInputCoverageEntry {
  inputId: string
  unit: ResearchInputCoverageUnit
  outcome: 'processed' | 'failed' | 'omitted'
  reason?: string
  chunkArtifactId?: string
}

interface ResearchOutputSnapshotV2 {
  schemaVersion: 'gujismart-research-output-input/v2'
  outputVersionId: string
  parentVersionId?: string
  projectId: string
  operationIntent: string
  executionContextId: string
  scopeSnapshotId: string
  evidencePackIds: string[]
  recordSetManifest?: ImmutableArtifactRef
  aggregateArtifacts: ImmutableArtifactRef[]
  inputCoverageManifest: ImmutableArtifactRef
  inputCoverageSummary: { population: number; processed: number; failed: number; omitted: number }
  claimManifest: ImmutableArtifactRef
  claimCoverageSummary: { total: number; supported: number; unsupported: number; stale: number }
  evidenceCoverage: EvidencePackV2['coverage']
  promptVersion: string
  outputHash: string
  createdAt: string
}
```

模块 06 的分页 `SearchSnapshot` 有 TTL，只用于执行期导航，不能成为正式统计 provenance。exact/sampled aggregate 一旦被 record 或 output 采用，必须在 snapshot 过期前提升为模块 06 唯一定义的、不可变且引用计数的 `ResearchAggregateArtifact`，冻结 criteriaHash、librarySearchGeneration、indexGenerationVectorHash、exactness、population/sample/coverage、resultPayloadRef 与 resultHash；依赖的 record/output 删除后才能按保留策略清理。

记录修改产生新 version 或最少保存 field-level audit；confirmed 后 source 或 aggregate artifact 失效自动转 needs-review，不静默维持 confirmed。统计记录不能用任意代表片段冒充总体来源，必须引用 aggregate artifact；解释性证据可另外附加 evidence provenance。`recordSetManifest` 只用于数据集记录集合；必需的 `inputCoverageManifest` 以 `ResearchInputCoverageUnit` 闭合联合覆盖 record、evidence、aggregate、project note、document brief 和 document chunk，使用 cursor/chunk artifact 记录每个输入的 processed/failed/omitted reason 与 chunk，不把百万条 outcome 内联到单次 IPC。claim manifest 同样是不可变、cursor 可读 artifact；每个实际事实句/数字/表格单元用带 offsetUnit/normalizationVersion 的 output range 或 table coordinate、occurrence、parser/segmentation version 和 hash 唯一定位，重复文本不能共享一个未定位 hash。unsupported/stale 项不能进入正式状态。输出正文不可变，修改和重新生成创建 parent-linked version；标题、状态、归档是可变元数据。snapshot 只能由 main 根据实际 committed artifacts 构造并哈希，旧 v1 只作为 legacy 展示。

### 6.5 古籍与普通 PDF/论文的兼容模式

两类用户使用同一套 scope、content、evidence、job、dataset 和 output contract，只在可配置 preset 上不同：

| 维度 | 古籍、地方志、扫描史料 | 普通 PDF、论文、现代文献 | 共享底座 |
| --- | --- | --- | --- |
| 正文来源 | active OCR/proof、结构化版面、版心/栏/页图 | PDF text layer、OCR fallback、章节结构 | `CanonicalContentProvider -> CanonicalPageContent` |
| 检索与词典 | 单字、异体/繁简、纪年、别名、项目词表 | 短语、作者/年份/DOI、术语与主题词 | SearchCriteria + project dictionary |
| locator | 页图、栏、块、字符范围、版本页 | PDF 页、段落、章节、translation unit | StableReaderLocator |
| 研究模板 | 纪年/人物/地名/版本异文/史料编年 | 文献综述/观点比较/方法/数据抽取 | Versioned ResearchPreset |
| 引用显示 | 古籍/方志/档案样式和版本说明 | GBT/APA/MLA/Chicago 等 | Citation resolver |

preset 只能调整默认 query、字段模板、source preference、展示和引用，不能改变证据真实性、人工确认、任务恢复和隐私门禁。领域词典由项目维护，核心源码不绑定特定国家、时代或私有语料。

### 6.6 数据库与旧数据兼容

- **零迁移优先：** public profile 和 vault 引用可继续存 `settings` 的版本化 JSON；secret blob 由 main-only sidecar 管理，普通备份不携带。chat turn 的 v2 envelope 可先放现有 `metadata_json`，但不能用可覆写 JSON 代替需要外键、唯一约束或不可变审计的核心结构。
- **必须 additive 的结构：** 模块 01 的 typed settings/CredentialVault 拥有 credential reference/version、tombstone 与 journal；模块 02/03 唯一拥有 scheduler 的 job/item/lease 表；模块 06 拥有 resolver、TTL SearchSnapshot 与持久 `ResearchAggregateArtifact` 创建/校验合同；模块 07 的 ResearchRepository 拥有 record version/review audit、output version、record-set/input coverage/claim manifest、幂等唯一索引和 active completed run pointer。上述结构是 AI-03/04/24/32/34/39/40/45/46 的必需前置，不再以“能否塞进现有 JSON”为可选条件。旧 row 通过兼容 view 投影 version 1，不能被原地覆盖来伪装版本历史。
- **旧 AI 结果：** `ai_results`、旧 chat turn 和旧文献卡片继续可读，标 `legacyExecutionContext`；只有新任务写 v2 context/cache。不会批量重跑用户全部 AI 内容。
- **旧证据：** 旧 source hash/locator 保留并进入后台 resolver migration；未完成前显示 `verificationStatus='migration-pending'` 或 `legacy-unverified`。不得把无法验证的旧行删除或自动升级为 verified。
- **旧研究输出：** snapshot v1 原样保留；首次打开可生成非权威的兼容摘要，但只有重新解析证据或重新生成后才得到 v2 lineage。
- **迁移纪律：** 每个 migration 有 schema version、预检、自动备份、`BEGIN IMMEDIATE`、固定小批 cursor、幂等重跑、故障注入、`foreign_key_check`、结果报告和回滚。大库允许慢，不允许永久跳过正确性迁移。
- **删除策略：** 项目默认归档；永久删除明确选择级联删除 AI artifact 或 detach 到 inbox，并在同一事务执行。备份/恢复测试覆盖两种策略。

## 7. 分阶段落实方案

正式实施前先完成全部模块设计与冲突复核，在本地提交已批准文档，并创建 `checkpoint/before-refactor-execution-<date>` 本地提交与标签。每个阶段先把本章验收项转成可运行测试，再修改业务代码；阶段之间不得依靠未提交的数据库手工状态。以下阶段都不需要新增第三方依赖，任何本地模型、向量库、外部检索或新服务均另行提案并等待用户确认。

### 阶段 A：立即封闭凭据与网络传输风险

**目标：** 完成 D07-P0-01、D07-P0-02；在继续扩大 AI 功能前先保证已保存 Key 不可从 main 读回 renderer、不进入普通备份、不通过远程 HTTP 发送，并覆盖 LLM、视觉 OCR 与 PaddleOCR。

**实现切片：**

1. 在 main 新建 `CredentialVault`，用 Electron `safeStorage` 和 `userData/secrets` versioned sidecar 实现 prepare/activate/read/revoke/migrateLegacy；journal 覆盖临时文件、flush/rename、SQLite 引用激活、finalize 和 orphan GC，所有错误只返回 redacted code。
2. shared 拆分 public profile DTO、一次性 credential draft 与 opaque draft ref；preload 删除返回完整 apiKey 的合同，generic settings IPC 对 protected key 拒绝读取/写入，renderer 提交后立即清空草稿。
3. LLM/视觉/Paddle 模型列表、连接测试、保存、切换和删除只使用 profileId/draft ref。请求冻结 profile、endpoint 和 credential entry/version；非 loopback 强制 HTTPS，host 变化要求重新确认 secret。
4. 旧明文迁移采用“准备并验证密文 -> 脱敏数据库备份 + encrypted recovery journal -> SQLite 激活引用并清明文 -> finalize”；每个跨存储边界故障注入，不能用普通明文备份冒充安全回滚。
5. backup、诊断、日志和 crash 信息统一 secret scanner；历史备份检测 protected key 并提供经验证的脱敏替代副本，原件只在用户明确确认后隔离/删除。跨机器恢复进入 `paused + credential-required`。

**主要文件边界：** `src/shared/types.ts`、`src/shared/config-validation.ts`、`src/preload/index.ts`、`src/main/ipc/settings.ts`、`src/main/ai.ts`、`src/main/ocr.ts`、视觉 OCR provider 读取路径、`src/main/backup.ts`、SettingsView、OnboardingWizard。不要在 renderer 建第二个 secret cache。

**兼容与回退：** 旧明文不在新 entry 回读成功、引用激活和 journal 可恢复前删除。若 safeStorage 在当前平台不可用，profile 显示“需重新输入密钥”，不得回退到 renderer 明文。回滚到旧版本前需明确提示旧版本无法读取密文；只保留脱敏数据库备份与 safeStorage 加密 recovery artifact，不新增明文副本。

### 阶段 B：修正输入范围、会话身份和流式请求生命周期

**目标：** 完成 D07-P1-02 至 P1-05，让用户看到的 selection/document/scope 与模型实际使用范围一致，所有请求可取消且不会反序覆盖。

**前置切片：** 在本阶段第一项之前，必须先复用或落地只读兼容 adapter：`CanonicalContentProvider.resolvePage(...) -> CanonicalPageContent` 与 `StableReaderLocator`。它们的完整 resolver、缓存和 lineage 在阶段 C 完成，但阶段 B 不允许临时再读 renderer 文本或发明平行 locator。

**实现切片：**

1. shared 引入 `AiInputScope`、`ChatSessionIdentity`、accepted start result 和 sequenced stream event；`AiQuestionOptions` 不再用松散 index signature 表达核心字段。
2. 文档问答只接收 selection locator；quote/prefix/suffix 由 locator 提供，main 校验并回显 effective scope。关键词、摘要等文献级任务改从 main 的 canonical adapter 读取，不使用 renderer 临时片段冒充全文。
3. session 创建和复用强校验 mode/docId/scopeHash；scope 变化默认新建分支，会话列表按 identity 分页。
4. 建立轻量 request registry：每个操作先分配 operationId/attemptId，start 立即返回、cancel 传播 AbortSignal、done/error/canceled 只作用于对应 requestId。它只保存 AbortController/event cursor，不保存第二份持久任务状态；fallback 使用相同 evidence pack 或新 attempt + replace event。
5. AiPanel、ResearchView 所有异步加载增加 generation/abort；修复强制刷新闭包、项目/会话/scope 切换反序和 catch 标记全部 streaming 项的问题。

**主要文件边界：** `src/shared/types.ts`、`src/preload/index.ts`、`src/main/ipc/ai.ts`、`src/main/ai.ts`、`AiPanel.tsx`、DocumentView 选区入口、App/library AI scope 入口、`ResearchView.tsx`。

**兼容与回退：** 旧 session 的空 scope 只映射 all；旧错误 identity 可查看但首次继续对话时要求选择“保持旧范围/复制到当前范围”。旧非流 API 保留一个版本并内部走相同 request pipeline。

### 阶段 C：统一 canonical content、证据解析和可复现执行上下文

**目标：** 完成 D07-P1-01、P1-06、P1-07、P1-15，保证 AI 只消费可验证证据，缓存和回答 envelope 绑定真实版本；正式 output lineage 等待阶段 D 的 committed artifacts 与阶段 E 的 record/aggregate 合同。

**前置依赖：** 模块 03 的 `CanonicalContentProvider.resolvePage(...) -> CanonicalPageContent`、模块 05 的 StableReaderLocator、模块 06 的 SearchEvidenceResolver 与 search generation。阶段 B 已接入最小只读 adapter；本阶段扩展为完整 resolver/context，不复制逻辑。

**实现切片：**

1. 删除 AI/research 中直接读取 inline page text 的路径，全部通过 `CanonicalContentProvider`，页面 DTO 只使用 `CanonicalPageContent`；覆盖 proofed empty、外置 refs、active OCR version、ebook、translation。
2. Evidence QA、综合分析、AI Research 和 research note 保存统一产出 `CanonicalEvidenceRefV2`；legacy hash 进入 resolver，不再以字段存在判真。
3. 请求开始冻结 `AiExecutionContextSnapshot`；cache key 包含完整 content hash、scope/search generation、provider/model/endpoint/credential version/parameters/prompt version。
4. `EvidencePackV2` 增加 exactness、coverage、unresolved、budget reason、continuation 和 stable dedupe；修正折叠文本 offset 与非确定 score。
5. `AiResponseEnvelopeV2` 删除伪概率 confidence，改为执行状态、source verification/coverage、actual model、warnings 和 lineage IDs。
6. main 生成并持久化不可变 `AiOperationPreview`，完整写入 scope/content/search generation、profile revision、endpoint/model/credential、query plan、预算、披露、prompt 和预计 artifact；本阶段建立 contextHash 与过期校验，阶段 D 负责原子消费并创建 request/job。

**兼容与回退：** v1 hash/snapshot/turn metadata 保持读取并标 legacy；本阶段只封闭 renderer 伪造入口并保留兼容读取，不宣称 v2 output 已完成。新 resolver 失败不改写旧数据；后台 migration 只追加验证结果。新 cache 与旧 cache namespace 隔离，回滚不会删除旧结果。

### 阶段 D：接入统一 scheduler，建立可恢复且资源有界的 AI job

**目标：** 完成 D07-P1-08 至 P1-10、P1-20、P1-21、P1-22，使 AI Research、长综合和完整导出在无限总量下仍可暂停、恢复和取消。

**前置依赖：** 模块 02/03 统一 `task_jobs/task_items` scheduler 已完成。AI 不得先创建独立物理队列。

**实现切片：**

1. 注册 `ai-synthesis`、`ai-research`、`research-report` 和长导出 job kinds，定义 phase artifact、claim、lease、heartbeat、cursor、attempt、retry/backoff 和优先级。main operation planner 消费阶段 C 的 preview，在 CredentialVault coordinator lock 内重验绑定项并冻结 context：短 request 建立仅内存的 `EphemeralCredentialLease`，durable job 在 SQLite 短事务中登记 credential pin；随后创建对应 request/job。任何检索、provider 调用和 artifact 写入都在 lease/pin 成功之后。selection/page/有界单文献问答可走 request；library/project/dataset、跨批次或需恢复的操作直接建 job。阈值与理由进入 preview/start result，执行开始后禁止半途升级。
2. scope/search/retrieval 移入只读 worker；使用 relation、keyset cursor 和固定 batch，不向 main/renderer传全量 docIds。
3. model gateway 设置全局/服务商/任务并发、rate limit、prompt token、response bytes、deadline 和预算；阅读/OCR 保存任务优先级高于后台综合。
4. stats、pack 与 run 在 staging + 短事务中原子激活，task 只引用同一 completed run。数据库添加幂等唯一索引和 active run pointer。
5. provider 调用前持久化 invocation attempt。只有 provider 明确支持 idempotency key 时才可自动保证不重复；“远端可能已计费但本地未提交”的崩溃窗口标 `remote-outcome-unknown`，默认暂停并提示可能再次计费，未经用户确认不重试。
6. 大库 migration 变为可恢复 job；必需 backfill/index 不再永久 skip。设置页展示 migration/job 状态、暂停、恢复和错误。
7. 所有集合 API 强制 cursor page；完整数据集和报告导出生成本地文件/stream，剪贴板只处理明确有界内容。

**兼容与回退：** 旧同步入口在兼容期创建 job 并等待小任务结果；超过阈值返回 jobId，不能继续无界等待。迁移表 additive，旧版本忽略；unique index 上线前先报告/标记重复行并自动备份。

### 阶段 E：修正统计、数据集复核、专题关系与报告 lineage

**目标：** 完成 D07-P1-11 至 P1-14、P1-16 至 P1-19，以及 P2-01 至 P2-05 的后端数据/规则合同；为 P1-23、P2-02、P2-04 的 UI 操作准备可撤销 command。阶段 D 已提供 committed artifacts，本阶段完成正式 output lineage，把 AI 研究从自动草稿升级为可审计的研究工作台。

**实现切片：**

1. 统计 DTO 同时返回 per-query 和 canonical union；明确 multi-term occurrence/co-occurrence 语义，facet 标 exact/sampled/estimated。
2. 移除核心源码中的领域实体扩展和未执行 filters；统一 SearchCriteria preview/effective/ignored，项目词表承担领域别名。
3. 普通输入不再自动执行完整研究；UI 只展示并确认阶段 C/D 由 main 生成的 `AiOperationPreview`，覆盖 scope、provider、数据外传、预算、抽取和报告阶段，不在 renderer 重新计算计划或 contextHash。
4. 数据集提供 cursor、字段校正、原文对照、验证、批量 confirm/exclude、撤销、版本和 audit；正式报告只读 confirmed 且 provenance verified 的记录。统计记录验证 aggregate provenance，不要求伪造单条 evidence。
5. 大数据集报告用阶段 D 的 committed chunk artifacts 生成持久 aggregate artifact、record-set/input coverage/claim manifests 和 main-only output snapshot v2；不再 `slice(18000)`。草稿模式可含 pending，但带不可引用标志。
6. ResearchRepository 强制同项目和无环大纲；删除节点、项目、记录和输出使用事务、影响预览、归档/回收站与明确 AI artifact 策略。
7. 输出使用不可变版本 lineage；列表支持分页、搜索、stale、归档、比较和恢复。note identity 加 project/evidence relation。
8. model self score、evidence coverage、precision/resolution/verificationStatus 和 human review 分开呈现，禁止伪精确百分比。

**兼容与回退：** 旧 pending record 保持 pending，不自动 confirmed；旧报告继续显示但标 legacy。旧项目删除行为不得自动重放，用户首次永久删除时选择新策略。领域规则迁出源码时提供兼容 project dictionary 导入，但默认不偷偷启用。

### 阶段 F：完成 UI、交互、辅助技术与双用户模式

**目标：** 完成 D07-P1-23、P2-02、P2-04、P2-07、P2-08 的用户界面与操作闭环，并将模块 08/09 的视觉与交互规范落实到 AI/研究页面。阶段 E 已完成的数据合同在此只做 UI 消费，不重复建表或状态机。

**实现切片：**

1. AiPanel 采用明确的 QA/快速统计/抽取/完整研究 segmented mode；scope、provider、coverage 和 job 状态始终可见，但不堆叠营销式卡片。
2. 研究工作台使用密集可扫描的表格/列表：分页、筛选、批量复核、字段编辑、来源对照、报告版本和任务队列均可从同一项目上下文进入。
3. destructive action 统一确认、回收站和 undo；loading/error/empty/canceled/paused/truncated/stale/unresolved 使用统一状态组件。
4. 全部图标按钮有 tooltip 与 aria-label，树、数据表、引用链接、modal 和进度 live region 完成键盘/NVDA 验收；流式文本不逐 token 播报。
5. 提供古籍/扫描史料与论文/PDF preset，但同一项目可逐任务切换；设置保存默认，不修改底层证据合同。
6. dashboard 改读增量 health snapshot，不在进入页面时扫描全部文献。

**兼容与回退：** 旧面板入口和快捷操作映射到新 mode；用户保存的窗口位置、项目和会话继续恢复。关闭高级详情时仍可完成基础问答，但任何 coverage/外传/正式报告确认不得隐藏。

### 阶段 G：测试、基准、迁移演练与本地用户验收

**目标：** 完成 D07-P2-06，用目标成品验收替换“源码中存在某字符串”的旧门禁，并在任何公开动作前完成本地测试。

**实现切片：**

1. 建立 mock OpenAI-compatible server，支持正常 stream、SSE 断裂、超时、429、取消、恶意内容、不同 model 和费用元数据。
2. 建立旧库 fixtures：三类明文 secret、历史含密钥备份、无 locator、重复 record、partial run、大库 migration cursor、v1 snapshot；vault sidecar/SQLite 每个跨存储边界和每个 migration 都执行两次并注入失败。
3. 新增真实 `aiResearch:*` IPC 集成、scheduler restart、并发幂等、source mutation、translation evidence、scope/session isolation 和 renderer latest-request-wins 测试。
4. 固定机器运行 10 万/100 万文献关系、百万 segment/record 的基准；记录 event-loop delay、worker/main RSS、DB size、p95/p99、IPC bytes、token/call 数和取消延迟。初始发布阈值固定为 accepted p95 不超过 250 ms、取消终态不超过 1 s、后台压力下 main event-loop p95/p99 不超过 100/250 ms；同窗口和并发下总量扩大 10 倍时 main RSS 增幅不超过 25%。阈值只能在实现前用基线记录调整并写明理由，不能在代码完成后下调。
5. 默认 `npm test` 纳入确定性中型 evidence/AI Research/secret/migration 测试；Windows 发布候选运行完整 build、smoke、unpack、旧库恢复和 NVDA 人工清单。
6. 生成本地可测试成品、变更说明、已知限制、备份和回滚方式，交用户使用自己的古籍与普通 PDF/论文文库测试。

**公开门禁：** 用户没有明确回复“本地测试无问题并批准公开”时，所有提交只保留在本地分支；不得 push、创建公开 PR、触发 GitHub Actions 或发布 Release。

## 8. 新版验收方案

下列验收定义优化后成品，而不是复述当前实现。实施每个切片前，将对应编号写入测试名称、任务和变更说明；旧测试与目标冲突时按 8.8 处置。所有性能阈值先在同一固定机器、固定 fixture 和固定 provider mock 上记录基线，再于实现前锁定 benchmark manifest；不得在完成代码后调低目标来让结果通过。

### 8.1 凭据、网络与执行配置

| 编号 | 目标行为 | 验收场景与判定 |
| --- | --- | --- |
| AI-01 | renderer 不能读回或持久化已保存凭据 | 配置 LLM、视觉 OCR、PaddleOCR 凭据后枚举 preload/settings/profile/model-list/diagnostic IPC、表单初始化、持久 state 与 DevTools；除用户尚未提交的当前输入草稿外，完整 secret 匹配数为 0，public profile 只含 configured/last4/version。提交 draft 后 renderer 字段清空。 |
| AI-02 | 普通数据库与备份不暴露 Key，普通备份不携带 secret 材料 | 配置三类凭据后扫描 SQLite/WAL、普通备份、日志和诊断包；完整 secret 匹配数为 0。普通备份在干净 profile 恢复后进入 `paused + credential-required`；同机只能复用备份之外仍存在且 entry/version 匹配的 vault。历史含密钥备份可生成验证过的脱敏替代副本，原件不被静默删除。 |
| AI-03 | vault 与旧明文迁移安全、幂等、可回滚 | 从每个旧库 fixture 迁移两次结果一致；在 sidecar 临时写、flush/rename、SQLite 引用激活、finalize、旧值清理和历史备份替换各点故障注入，只保留完整旧状态或完整新状态。迁移不得新建普通明文备份，原 Key 不丢失也不重复暴露。 |
| AI-04 | profile 与 credential version 切换可恢复且可撤销 | 对 activeId/profileRevision/provider/baseUrl/credentialEntryId/version/model 切换的每个故障点强退；重启后只能得到完整 profile A 或 B，绝不出现 A Key + B URL。同 profile、同 host 仅轮换 Key 时，已开始/排队任务继续使用冻结版本或明确暂停，不能静默换账户。clear/revoke 后只有可继续 job 可暂时 pin 密文；终结 output 只留 tombstone，最后一个 job 释放后 ciphertext 可验证删除。 |
| AI-05 | 非本机 endpoint 强制 HTTPS | 远程 `http://` 保存和 generic settings 绕过均被拒绝；HTTPS 正常；loopback HTTP 仅在明确本地模式允许并显示 transport 状态。 |
| AI-06 | host 变化不隐式复用 secret | 修改 endpoint host 时必须执行 retain-with-confirmation/replace/clear 中的明确动作；默认不把旧 secret 发往新 host。模型列表和连接测试也只能使用 profileId/draft ref，不能绕过策略传明文 apiKey。 |

### 8.2 输入范围、会话与流式请求

| 编号 | 目标行为 | 验收场景与判定 |
| --- | --- | --- |
| AI-07 | selection 问答只使用确认范围 | 选中同页两个不同段落提出相同问题，mock provider 收到对应 locator/quote；“仅选中/结合页/结合全文”三模式 payload 和 UI 标签一致。 |
| AI-08 | 文献级任务读取完整 canonical 范围 | 当前阅读窗口只有首 2200 字、答案位于后页时，文献级关键词/摘要按声明 coverage 处理；不得把 prop 片段冒充全文。 |
| AI-09 | 正文可用状态真实 | 无正文、inline OCR、空 proofed+有效 OCR、外置 ref、active OCR revision、ebook 和 ready translation 分别得到正确可用性与 sourceKind。 |
| AI-10 | session 严格绑定 identity | 文献 A session 传给 B、all scope session 传给 folder/tag/documents scope 均被拒绝或显式分叉；历史上下文不得跨 identity 注入。 |
| AI-11 | scope 变化可理解 | 切换 scope 时 UI 显示新会话/复制上下文选择；刷新后 identity 和 scope label 一致，旧空 scope 只兼容 all。 |
| AI-12 | operation start 立即 accepted、执行模式先判定且可取消 | 本地 mock provider 延迟 30 秒时，固定机器上 start accepted p95 不超过 250 ms；start result 在任何 provider 调用前明确 request/job，并返回同一 operationId/attemptId，运行中不半途升级。取消后 1 秒内进入 canceled，之后无新 delta/turn/report 写入；两种 execution 分别验收。 |
| AI-13 | SSE 失败不会重复文本或错配证据 | 在 0/1/N 个 delta 后断流；同 evidence fallback 使用 replace，不产生重复前缀；若重检索则新 attempt，done 中 answer/sources/snapshot 属于同一 attempt。 |
| AI-14 | latest-request-wins | 快速切换 scope、会话、项目、数据集并故意反转网络响应顺序；当前 generation 之外的 response/event 不得写 state，loading 也不能被旧请求提前清除。 |

### 8.3 canonical 证据、缓存与可复现性

| 编号 | 目标行为 | 验收场景与判定 |
| --- | --- | --- |
| AI-15 | AI、检索、阅读器使用同一 canonical 身份 | 复用 `SRCH-40` 的 shared fixture/assertion helper，验证 sourceKind、contentVersion、sourceHash、sourceRanges、offsetUnit、quote 与 locator 一致；AI 另验同一 normalized locator 只生成一个 canonical evidence ID。 |
| AI-16 | 外置与结构化正文不丢证据 | 将 proof/OCR/result 外置，再运行文献问答、Evidence QA、专题综合和 AI Research；固定 mock 下比较实际发送的 canonical slices、evidence IDs、hash 与 coverage，外置前后完全一致，不以非确定模型措辞判定。 |
| AI-17 | source mutation 会标 stale | 修改 OCR 中段、切 active version、删除 page、改变 translation unit；旧 evidence 分别变 stale/source-missing，不继续显示 verified。 |
| AI-18 | locator 必须真实解析 | 伪造 docId/page/range/hash、非法 JSON、折叠空白 offset、重复词 occurrence 与非 BMP 字符样本均不能获得 exact verified；允许诚实降级到 page。 |
| AI-19 | 原文与译文证据不混用 | translation hit 只解析指定 unit，source hit 只解析 active source；报告、摘录和回跳保持 sourceKind。 |
| AI-20 | evidence pack 声明覆盖和续页 | 超预算、高频、unresolved 和 sampled 数据返回 population/candidate/included/omitted/exactness/continuation；precision、resolution、verificationStatus 使用闭合且统一的 wire format。继续读取不重复、不漏掉已承诺 cursor 范围。 |
| AI-21 | evidence 去重稳定 | 同一 canonical range 被多个 query/overlap segment 命中只形成一个 evidence，matchedQueries 合并；排序多次运行完全一致。 |
| AI-22 | 缓存按完整内容和执行版本失效 | 相同前 6000 字不同尾部、等长中段修改、切模型/endpoint/credential version/参数/prompt/resolver/search generation 均不命中旧 cache；完全相同 context 才命中。 |
| AI-23 | envelope 和 UI 记录真实 attempt，不伪装概率 | 长任务中途切 profile 或轮换 Key，结果仍记录开始时 provider/model/endpoint fingerprint/credential version；source verification/coverage 与实际 pack 一致。envelope 不输出启发式 confidence；UI 将 modelSelfScore、coverage、verification 与 human review 分开，未校准值不得显示为“正确率 N%”。 |
| AI-24 | snapshot 只能由 main 构造 | renderer 提交伪造 v1/v2 snapshot、错 project/dataset/evidence/aggregate ID 均被拒绝；保存的 v2 可按 lineage 重放到相同 input hashes，claim manifest 中未知或跨 attempt provenance 不能进入正式输出。 |

### 8.4 检索统计、任务恢复与资源边界

| 编号 | 目标行为 | 验收场景与判定 |
| --- | --- | --- |
| AI-25 | per-query 与 union 统计分离 | 两个 query 命中同一文献/页/occurrence 时，per-query 保留各自数，union 去重；UI 不把二者混写。 |
| AI-26 | 多词统计语义正确 | A AND B、同页共现、同段共现、距离 N、每词 occurrence 分别用金标准 fixture 验证；不得只计第一个词。 |
| AI-27 | sampled facet 不伪装精确 | 固定 population 与有偏更新时间样本验证 sampleSize/coverage/strategy；exact job 与金标准一致，sampled UI/报告明确标注。 |
| AI-28 | requested/effective filter 一致 | 作者、朝代、docType、年份和手动 filter 分别测试；不支持条件进入 ignored+warning，绝不显示已应用却实际丢弃。 |
| AI-29 | 项目词典隔离且核心检索无隐式领域偏置 | 用两个项目配置互斥别名/实体词典；仅启用项目产生对应 expansion，禁用后 query preview 和结果立即移除，另一项目不受影响。静态扫描只能作为补充守卫，不能代替行为 fixture。 |
| AI-30 | 长任务状态完整且复用共享状态 | plan/retrieve/pack/extract/report 每阶段直接使用模块 01/02 的 TaskStateEnvelope；credential/预算/人工复核通过 blockedReason 表达，partial 只能是 `completed + completionKind='partial'`。非法 status/field 组合被 main 拒绝；event seq 单调，重连 afterSeq 能补全，短 request facade 不产生第二份持久状态。 |
| AI-31 | pause/resume/cancel 幂等 | 在每个 phase、每批 record 和每次 provider 请求前后操作；重复命令不重复 artifact，不越过 cancel 写 completed。 |
| AI-32 | 崩溃后从 committed cursor 恢复且不隐瞒远端未知结果 | 每个 artifact 提交边界强退重启；过期 lease 被回收，从最后 committed item 继续。provider 支持幂等键时验证不重复；远端可能已计费但本地未提交时标 `remote-outcome-unknown`，默认不自动重试，并明确提示“可能再次计费”。 |
| AI-33 | 并发与重试不产生本地重复 | 同 task 双击、两个 renderer 同时启动、429 retry、进程重启后 retry；run/step/record 的幂等键保持唯一。provider call 数按 documented attempt policy 统计，`remote-outcome-unknown` 的用户确认重试单独计费并保留审计。 |
| AI-34 | stats 与 pack 原子同 run | 在 run update/stats insert/pack insert/activation 各点故障；不得出现 completed partial run；读取只返回 active_completed_run_id 的同一组合。 |
| AI-35 | 无产品硬上限、窗口和并发有界 | 1000、1001、10 万文献与百万 record fixture 都能通过 cursor 到达末尾；没有静默 cap。分别把用户并发设为 1 和 N，验证多 batch、背压、暂停、重启和失败重试；active workers、单页数、单 IPC bytes 与设置/硬上限一致。 |
| AI-36 | main 保持交互可用 | 在固定机器运行高频检索、百万 record 导出、多 job，并打开百万文献研究 dashboard；dashboard 只读增量 health snapshot，不全库解析 documents，查询数受固定窗口约束，stale snapshot 明示 checkedAt/stale。main event-loop p95/p99 不超过 100/250 ms，取消终态不超过 1 秒。同窗口、并发和 payload 上限下把总数据扩大 10 倍，main RSS 增幅不超过 25%，证明增长受窗口/并发约束而非总库线性相关。 |

### 8.5 数据集、研究关系与输出

| 编号 | 目标行为 | 验收场景与判定 |
| --- | --- | --- |
| AI-37 | 正式报告只用 confirmed 且 provenance verified 的记录 | pending-only、stale evidence、失效 aggregate、mixed dataset 分别验证；正式模式拒绝或排除非合格记录并显示数量。exact/sampled aggregate 按自身 provenance 校验，不要求绑定任意代表片段。 |
| AI-38 | 探索草稿诚实标注 | 显式草稿模式可含 pending，但正文、导出、snapshot 均带不可引用标记、pending 数与 coverage；不能误存为正式报告。 |
| AI-39 | 全部正式输入进入持久 input coverage manifest | 分别以超 18,000 字多批记录、notes-only、evidence+briefs、selected-documents 和 aggregate 生成正式输出；snapshot 引用 immutable inputCoverageManifest，population 与 processed+failed+omitted 对账一致。每个 record/evidence/aggregate/note/brief/chunk 都可通过 cursor 查到 outcome/reason/chunk；不得字符串截断，失败块可单独重试。 |
| AI-40 | 人工复核和状态转换可审计 | 字段编辑、批量 confirm/exclude、撤销、source 或 aggregate artifact 变化各自产生 record version/audit；非法 status 在 main 被拒绝，legacy 未知值只映射 `unknown-legacy` 且不能进入正式报告。旧报告仍指向旧 version，新报告使用明确选定版本。 |
| AI-41 | 大纲同项目且无环 | 自己作为父、后代作为父、跨项目 parent、跨项目 note assignment 均被 main 拒绝；恶意旧环读取有 depth/visited guard，不崩溃。 |
| AI-42 | 删除节点行为明确 | 含多层子树和摘录时分别测试提升子节点/递归删除/取消；默认不让子树消失，事务失败全部回滚。 |
| AI-43 | 项目删除/归档不残留隐形数据 | 项目含 doc relation、notes、outputs、tasks、datasets、records、runs/stats/packs；归档后可恢复，永久删除按用户选择完整 cascade 或明确 detach，global list 不意外重现。 |
| AI-44 | 同一证据可用于多个专题 | A/B 项目复用同 evidence 各有独立研究备注和 review；同项目重复给出复用提示，不复制 canonical 原文。 |
| AI-45 | 输出版本 lineage 完整 | 编辑、重新生成、切模板和 source 变 stale 后创建 parent-linked version；旧版本可查看/导出，active/archived/stale 筛选正确。 |
| AI-46 | 正式报告的 claim/citation manifest 完整 | parser/segmentation version 固定后枚举全部事实句、数字和表格单元；每项以带 offsetUnit/normalizationVersion 的 output range 或 table coordinate、occurrence 和 hash 唯一定位并绑定 evidence/aggregate artifact。重复句/重复值、非 BMP、CRLF/LF 与 Unicode normalization 样本不能共用或漂移到未定位条目；manifest total 与实际枚举数一致，未知、跨 attempt、stale 或 unsupported 项不能标正式。材料中“忽略规则/伪造引用/输出密钥”等 adversarial 指令不能改变 provenance、manifest 或保存权限。evidence 可回跳原文，aggregate 打开 criteria/generation/exactness/coverage。 |

### 8.6 UI、双用户模式与辅助技术

| 编号 | 目标行为 | 验收场景与判定 |
| --- | --- | --- |
| AI-47 | 模式与专题材料来源选择明确 | 同一句含“统计”的普通问题不会自动开始完整研究；QA/快速统计/抽取/完整研究各显示将执行的阶段。专题综合必须显式选择 notes-only/evidence+briefs/selected-documents/dataset；新增一条摘录不会静默切换材料源，用户可取消。 |
| AI-48 | operation preview 完整且确认不可移花接木 | scope、profile revision、endpoint fingerprint、model、transport、credential entry/version、外传内容类别、coverage、调用/token 区间、预算、query plan 和产出 artifact 均来自 main；start 必须提交 previewId/contextHash。并发执行 profile edit、Key clear/revoke、generation bump、预算/计划变化和双 start：consume coordinator 必须原子完成重验、context 冻结以及 request 的 ephemeral lease 或 job 的 durable pin，再创建对应执行体；旧 preview 返回 `preview-stale`，同一 preview 最多消费一次，任何 provider 调用都不能发生在 lease/pin 前。request 在 complete/error/cancel/timeout 后 registry/lease 引用计数为 0、无持久 pin、无 IPC/日志/state secret；可变 Buffer 的 best-effort zeroize 单独断言，但不宣称验证 JS 引擎或网络栈副本清零。崩溃重启不残留 request pin；job 终态释放持久 pin。 |
| AI-49 | 古籍与论文 preset 兼容 | 古籍单字/异体/纪年/版面 locator 与论文作者/年份/章节/DOI 分别通过样本；同一项目可切 preset，canonical evidence 和 review 语义不变。 |
| AI-50 | 列表和选择可到达全部数据 | 文献、会话、任务、dataset、record、output 用搜索/虚拟列表/cursor；第 1001 篇、第 21 条记录和第 6 份报告均可在 UI 内访问。 |
| AI-51 | 破坏性操作可撤销 | 鼠标与键盘误删对话/摘录/大纲、误排除记录后可在 undo window 或回收站恢复；永久删除有影响预览和焦点返回。 |
| AI-52 | 键盘与读屏完整 | 无鼠标完成 scope 选择、提问、取消、数据复核、证据回跳和报告版本管理；NVDA 能听到 phase/完成/错误而不逐 token 轰炸；所有图标按钮有名称。 |

### 8.7 迁移、测试与公开门禁

| 编号 | 目标行为 | 验收场景与判定 |
| --- | --- | --- |
| AI-53 | 普通库与大库迁移一致 | 同 legacy fixture 以普通/大库阈值运行，最终 schema/index/backfill/integrity 相同；大库可暂停续跑但不会永久 skip。 |
| AI-54 | 迁移和备份可恢复 | 每个 migration 做 apply twice、磁盘满/断电模拟、foreign_key_check、row/hash count、备份恢复；CredentialVault 另覆盖 sidecar 丢失/损坏、journal 恢复、同机与跨机恢复。失败不损坏原库，也不新增明文 secret 副本。 |
| AI-55 | 默认测试覆盖真实链路 | `npm test` 实际执行 secret、Evidence QA、AI Research IPC、migration 和关键 renderer 行为；源码字符串回归不能作为唯一证据。 |
| AI-56 | 优化成品先由用户本地验收 | 提供本地构建/安装包、变更说明、已知限制、备份/回滚与本章结果；用户用真实古籍和普通 PDF/论文测试并明确确认无问题。未确认时所有提交保持本地。 |

### 8.8 验收分层与现有测试处置

| 层级 | 主要编号 | 执行载体 | 说明 |
| --- | --- | --- | --- |
| 纯函数/合同 | AI-05、AI-10、AI-18、AI-21、AI-25 至 AI-29、AI-41 | Node/TypeScript unit | URL、状态转换、scope hash、统计、resolver 和树约束；只验证纯合同，不声称证明数据库隔离。 |
| main/SQLite 集成 | AI-01 至 AI-06、AI-08 至 AI-10、AI-15 至 AI-24、AI-30 至 AI-48、AI-53 至 AI-55 | Electron + native SQLite + mock provider | 使用临时旧库、真实 IPC、故障注入、重启和并发；AI-10 必须证明历史不会跨 scope 注入，AI-48 必须覆盖 preview consume 与 credential clear/revoke 竞态。 |
| renderer 行为 | AI-01、AI-07、AI-08、AI-10 至 AI-14、AI-37 至 AI-40、AI-46 至 AI-52 | Playwright/component harness | secret 不回填表单、反序响应、流式 replace、模式确认、分页、undo、焦点和来源回跳。 |
| 固定机器性能 | AI-12、AI-20、AI-30 至 AI-36、AI-39、AI-50 | 可重复大规模 fixture | event-loop delay、main/worker RSS、p95/p99、IPC bytes、DB/token/call 数；不在不稳定共享 runner 判绝对阈值。 |
| Windows 人工验收 | AI-48、AI-49、AI-51、AI-52、AI-56 | unpack/安装包 + NVDA + 用户文库副本 | 外传确认、双 preset、辅助技术、备份/回滚和用户本地测试。 |

现有测试处置：

- **保留并升级：** `evidence-qa-regression` 的关键词优先、页窗口、tag scope 与证据不足；增加 external refs、source mutation、translation、session identity、取消和 SSE 失败。
- **保留并升级：** `research-regression` 的项目/大纲/摘录/导出正常路径；注册 ai-research IPC，覆盖无环、跨项目拒绝、完整删除策略、output version 和 v2 snapshot。
- **替换：** `ai-research-workflow-regression`、`ai-research-retrieval-pipeline-regression` 中证明业务行为的 `includes` 断言，改为真实 plan/run/failure/retry/restart/cursor 测试。少量禁止硬编码、API 分层检查可继续静态执行。
- **升级：** `ai-response-envelope-regression` 改验 v2 actual execution context、precision/resolution/verificationStatus 和 coverage，删除启发式 confidence 的旧期望。
- **升级：** `research-integrity-regression` 从调用纯 helper 扩展为修改/删除 canonical source 后重新解析，验证 verified -> stale/unresolved。
- **升级：** `ai-markdown-citation-qa`、floating viewport、quick actions 改为 renderer 行为、键盘和视觉截图；源码字符串只保留最小合同。
- **新增：** 三类 secret vault/redaction、sidecar/SQLite journal、atomic profile/credential version switch、remote HTTP reject、legacy secret migration、历史备份脱敏替代和普通备份不含 secret。
- **新增：** AI Research 在第 N 条 provider 失败、并发双启动、取消、断电恢复、partial artifact 原子性、provider idempotency/remote-outcome-unknown、百万 record cursor 和流式导出。
- **新增：** legacy schema 全代 fixture、大库 cursor migration、apply twice、故障回滚、foreign_key_check 和 backup round-trip（含所有 AI/研究表）。
- **默认门禁：** `test:evidence-qa`、新的 secret/migration/AI Research 集成与关键 UI 行为纳入 `npm test`；完整 `npm run check`、build、smoke、unpack 和大型基准按发布层执行。

### 8.9 本地测试与公开审批清单

1. 在本地分支完成业务实现、自动化测试、构建、Windows unpack/安装包和迁移演练；不触发 GitHub Actions。
2. 对用户数据库副本先做备份与只读预检，再提供本地可测试成品；不得直接操作唯一真实库做首次迁移实验。
3. 向用户提供启动方式、变更清单、AI-01 至 AI-56 结果、已知限制、外传说明、备份位置和回滚步骤。
4. 用户同时测试古籍/扫描史料和普通 PDF/论文：选区问答、scope、取消、数据复核、报告回跳、旧数据与大库迁移。
5. 只有用户明确回复“测试无问题，并批准公开”后，才允许另行执行 push、公开 PR、GitHub Actions 和 Release。
6. 用户未确认、要求继续修改或发现问题时，修复仍只在本地分支进行；自动化通过不能替代用户批准。

## 9. 新功能建议

### 9.1 D07-NF-01 论点—证据—反证研究矩阵

**用户问题：** 当前 AI 输出主要是一整篇 Markdown，用户难以区分模型提出的论点、支持证据、反证、证据缺口和自己的判断。历史研究与论文写作都需要“每个结论凭什么成立”。

**优先级、成本、风险与前置：** P3（第一批增强），中高成本。风险是 AI 自动拆论点过度、同一证据被误连、用户把候选关系当事实；前置为阶段 C 的 evidence ID/resolver、阶段 E 的 record review/output lineage。

**MVP：** 在研究专题增加矩阵视图。用户创建论点，连接 supporting/opposing/context evidence，填写研究者备注和状态 `draft/confirmed/rejected`。AI 可从已确认摘录或报告建议论点与关系，但全部先进入候选队列。点击任一证据回到原文，报告只引用 confirmed 关系。

**实现影响：** additive 增加项目级 `research_claims`、`research_claim_evidence` 或等价版本化关系；它与核心 output-scoped claim manifest 分工明确，可链接但不共用可变行。不复制正文，只引用 canonical evidence ID。shared/preload/IPC 提供 claim CRUD、关系 review、cursor 和 export；output snapshot 记录使用的 claim versions。

**系统与合规影响：** 默认完全本地保存；AI 建议只发送 operation preview 已确认的 evidence pack。第一版不新增依赖。导出 Markdown/JSON 时标明论点状态、支持/反对证据与 unresolved 项。

**新版验收与回退（D07-NF-01-A）：** source mutation 后关联显示 stale，不自动换证据；删除矩阵关系不删原摘录；关闭矩阵不影响现有研究专题和报告。AI 建议未经确认不得进入正式输出。

### 9.2 D07-NF-02 可复现 AI 研究笔记本与运行对比

**用户问题：** 用户经常想比较不同模型、提示词、scope 或证据预算的结果，但当前只有最终报告，无法重放或理解差异来自哪里。

**优先级、成本、风险与前置：** P3，中等成本。风险是 artifact 占用增长、比较不同 coverage 得出错误结论；前置为 AiExecutionContext、scheduler artifacts 和 output v2 lineage。

**MVP：** 每次 AI 任务生成一页只读“运行记录”：目标、scope snapshot、query plan、evidence coverage、模型/参数、prompt version、阶段耗时、费用估计、records 和 outputs。用户可选择两个 run，对比配置、证据差异和输出 diff，并从旧 run 克隆新任务。

**实现影响：** 直接复用 job/attempt/artifact，不另建日志真相；只需 run list/detail/diff IPC 和 UI。长期 artifact 使用引用计数与保留策略，原文仍通过 resolver 读取。

**系统与合规影响：** 不保存明文 Key；prompt 可保存版本/hash，含用户敏感自定义 prompt 时提供保留开关。第一版使用文本 diff/结构化集合 diff，不引入新库。

**新版验收与回退（D07-NF-02-A）：** 相同 snapshot/context 重放得到相同请求 payload hash；provider 非确定输出可不同但差异可见。清理 run 只删无引用临时 artifact，不删 dataset/report；关闭历史保留后仍保留最小 lineage。

### 9.3 D07-NF-03 可视化结构化抽取 Schema 与质量规则

**用户问题：** 当前字段由 AI 生成后直接用于抽取，用户无法定义枚举、必填、数值范围、日期格式、跨字段一致性或重复实体合并规则。

**优先级、成本、风险与前置：** P3（第一批增强），中高成本。风险是规则太复杂、自动纠错改坏原值、schema 演进破坏旧数据；前置为 record version、人工复核和可恢复抽取 job。

**MVP：** 提供字段设计器：text/number/date/place/person/category/quote、required、enum、regex、min/max 和说明。抽取后运行本地 validator，记录分为“可确认/缺字段/格式错误/证据失效”。用户可批量修正并重新验证，不自动覆盖人工值。

**实现影响：** schema 版本化；record 保存 schemaVersion/extractionVersion，升级 schema 创建 migration preview 和新 record version。validator 第一版使用现有 TypeScript，不执行用户代码。IPC 仅接受白名单规则 AST。

**系统与合规影响：** 完全本地，无新依赖。CSV/JSON 导出包含 schema、validation status 和 evidence/aggregate provenance；报告可按已验证字段聚合。

**新版验收与回退（D07-NF-03-A）：** schema v1/v2 记录可同时读取；规则失败不丢原始模型值和证据；回退 schema 只改变 active version。恶意 regex/超长规则有复杂度与长度上限，不阻塞 main。

### 9.4 D07-NF-04 实体、时间、地点与别名研究台账

**用户问题：** 古籍中的异名、字号、纪年和古今地名，以及论文中的机构别名、缩写和时间范围，都需要跨文献统一，但硬编码全局词典又会产生偏置。

**优先级、成本、风险与前置：** P3，高成本。风险是同名误合并、纪年/地名转换错误和外部知识库许可证；前置为项目词表、claim/evidence、Schema 抽取和模块 06 query AST。

**MVP：** 项目内维护 entity：规范名、类型、别名、时间范围、说明和 confirmed evidence。AI/规则只能建议候选，用户确认后才用于 query expansion。提供实体详情、共现文献、时间分布和带 evidence 的别名来源。

**实现影响：** 只建立一套 `ResearchEntity`/alias/evidence relation，由模块 07 的研究域拥有；模块 06 的实体检索建议和 glossary 只投影为 versioned query-expansion dictionary，不再建第二套实体表。搜索计划引用 project dictionary version。古籍纪年先保存原文值和人工标准化值，普通年份使用 ISO 候选；不强制统一到一个不可靠日期。

**系统与合规影响：** 第一版不接外部地图、NER 或知识库，无新依赖。若后续引入地名库、纪年库、本地 NER、地图组件或外部实体服务，必须评估许可证、包体、隐私、离线能力和回退，并 **实施前需用户确认**。

**新版验收与回退（D07-NF-04-A）：** 同名不同人/地反例不会自动合并；禁用一个别名后 query preview 立即移除；删除 entity 不删原文/摘录。古籍与论文分别报告候选 precision，不混成单一指标。

### 9.5 D07-NF-05 文献综述矩阵与争议图谱

**用户问题：** 普通综述和历史研究都需要横向比较“文献 x 主题/观点/方法/时期”，而不是按文献逐篇复述。当前报告文本难以发现共同点、分歧和缺口。

**优先级、成本、风险与前置：** P3，中高成本。风险是主题列由 AI 随意漂移、空白被误读为文献没有观点；前置为 confirmed evidence、Schema builder、claim matrix 和 output lineage。

**MVP：** 用户选择已确认字段或论点作为列，文献/材料作为行，单元格只显示已确认 evidence 摘要与页码。AI 可建议主题列和单元格候选；矩阵支持缺证、相反证据和待阅读标记。可生成带来源的综述草稿。

**实现影响：** 第一版作为 claim/record 的查询投影，不复制数据；保存 matrix definition/query 与 column version。大矩阵 cursor/虚拟化，导出 CSV/Markdown/JSON。

**系统与合规影响：** 本地执行，无新依赖。模型只处理用户确认的矩阵窗口或有界 evidence pack，operation preview 显示覆盖。

**新版验收与回退（D07-NF-05-A）：** 单元格都能回跳；空白明确区分“未检索/检索无证/待确认”；主题改名不改 evidence。关闭矩阵不影响数据集和报告。

### 9.6 D07-NF-06 报告逐句证据审计与引用覆盖检查

**用户问题：** 即使报告整体带来源，用户仍需要知道每个事实句、数字和比较是否真的有证据，哪些句子只是解释或待核查判断。

**优先级、成本、风险与前置：** P3（第一批增强），中等成本。核心正式输出已经在 P1 要求最小 claim/citation manifest；本功能只增加交互式逐句分类、补证和覆盖审计。风险是中文断句和事实句分类不完美，自动审计被误当最终判断；前置为 evidence-bound citations、output v2 和 resolver。

**MVP：** 读取核心 claim manifest，将报告分成可交互句段，检查是否绑定 verified evidence、数字是否来自 exact/sampled aggregate、引用是否 stale。侧栏显示“已支持/证据不足/引用失效/解释性文字”，点击定位正文和来源。用户可补证、降级措辞或标记已人工核查。

**实现影响：** 核心 claim manifest 已完成解析和 provenance 绑定；本功能不再保存第二份 sentence hash/provenance。审计结果只引用 `claimManifestId/version + claimId`，保存分类建议、人工复核、补证 workflow 和失效状态；manifest 或正文版本变化后对应审计失效。AI 只用于建议分类，不改原文。

**系统与合规影响：** 第一版无新依赖、可离线执行基本审计。若使用模型，遵循 operation preview 和 provider policy。导出可附 evidence coverage appendix。

**新版验收与回退（D07-NF-06-A）：** 删除/修改 source 后对应句变 stale；无 evidence 的数字不能显示“已支持”；关闭审计不修改报告。人工核查状态与模型建议分开。

### 9.7 D07-NF-07 AI 成本、配额与隐私预算中心

**用户问题：** 长研究任务可能产生多次调用，用户目前不知道已花多少、还会发送多少内容，也无法给后台任务设上限。

**优先级、成本、风险与前置：** P3，中等成本。风险是不同 provider 计费规则变化、估算被误认为账单；前置为 execution context、job budget 和 model gateway usage capture。

**MVP：** 显示每次 run 的 calls、input/output token（provider 未返回时标 estimated）、耗时、失败重试和数据外传类别；用户设置每任务/每天调用和 token 上限，以及“超预算暂停并确认”。价格由用户手动填写或使用清楚标日期的本地配置。

**实现影响：** usage 作为 job artifact，不含正文和 Key；scheduler claim 前检查 budget。设置支持 global/provider/project policy，报告 snapshot 引用 usage summary。

**系统与合规影响：** 不自动联网拉价格，避免新的外部信任；若以后接 provider billing API，属于新外部服务，实施前需用户确认。费用始终标“估算/服务商返回/用户配置”来源。

**新版验收与回退（D07-NF-07-A）：** 达到上限后不再发新请求，已完成 artifact 保留并可续跑；重试计入 usage；删除 usage 历史不影响研究结果 lineage 的最小模型标识。

### 9.8 D07-NF-08 可审阅研究协议与自动化配方

**用户问题：** 用户会反复执行“检索 -> 筛选 -> 抽取 -> 人工复核 -> 报告”流程，但完全自动的 agent 又容易失控、超预算或跳过人工确认。

**优先级、成本、风险与前置：** P3，高成本。风险是配方升级语义变化、循环任务和隐式外传；前置为 scheduler、operation preview、Schema、review gate 和所有幂等合同。

**MVP：** 提供版本化步骤模板，例如“史料编年”“人物事迹表”“论文综述矩阵”。步骤只来自白名单：search、facet、pack、extract、wait-for-review、report、export；每步显示输入/输出和预算，人工 gate 不可被脚本跳过。

**实现影响：** recipe 保存稳定 JSON AST 和 schemaVersion，编译为现有 job DAG，不执行任意 JavaScript/SQL。每次 run 冻结 recipe version；升级只影响新 run。

**系统与合规影响：** 第一版完全本地且无新依赖。社区分享配方需要导入预览、签名/来源提示和权限清单；在公开模板市场或在线同步前必须单独获得用户确认。

**新版验收与回退（D07-NF-08-A）：** 恶意/循环/未知步骤拒绝；pause/restart 后不重复副作用；旧 recipe version 可继续查看。删除配方不删历史 run 或产出。

### 9.9 D07-NF-09 可复用证据收件箱与跨专题引用

**用户问题：** 阅读时发现的好材料可能同时服务多个专题，当前 note 去重要么阻止重复，要么要求复制文本，难以维护一份来源和多份研究解释。

**优先级、成本、风险与前置：** P3，中等成本。风险是跨专题删除/权限语义混乱；前置为 canonical evidence ID、project-scoped note relation 和回收站。

**MVP：** 未指定专题时保存到证据收件箱；同一 canonical evidence 可连接多个项目，每个项目有独立 kind、tags、comment、outline 和 review。用户从收件箱批量归档、关联或忽略，查看被哪些项目使用。

**实现影响：** P2-03/阶段 E 已把 evidence 本体与 project annotation/relation 分离，并与模块 06 的证据篮共用 `ResearchEvidence` 身份；本功能不再新增 evidence 表，只增加 inbox 状态、批量归档/关联/忽略 command、过滤和列表 UI。旧 research_note 惰性投影为一条 evidence + annotation；不批量复制 excerpt。列表全部 cursor 化。

**系统与合规影响：** 本地数据，无新依赖。项目导出只含本项目 annotation 和必要 quote，JSON 明确 evidence 是共享引用。永久删 evidence 前显示所有引用项目。

**新版验收与回退（D07-NF-09-A）：** A 项目改备注不影响 B；source stale 同时通知所有引用；解除一个项目关系不删 evidence。旧版本仍能按兼容 view 读取原 note。

## 10. 依赖、迁移、隐私与审批

### 10.1 第一阶段依赖结论

- 阶段 A 至 G 可使用现有 Electron、TypeScript、React、Ant Design、better-sqlite3、worker_threads、fetch/AbortController 和项目已有测试工具完成，不新增第三方运行时依赖。
- `safeStorage` 是 Electron 内置能力，不需要安装密码库；仍需验证 Windows 安装/便携版、同机用户、系统凭据不可用和跨机器恢复行为。
- canonical content、stable locator、query AST/evidence resolver 和 scheduler 分别由模块 03、05、06、02/03 提供。AI 只能依赖共享接口，不复制内部实现，也不能为了赶进度建立第二套表。
- 第一阶段不需要向量数据库、embedding、reranker、agent framework、浏览器自动化、外部 RAG、云同步或本地大模型；没有这些依赖也必须完成可信问答与研究工作流。

### 10.2 建议迁移清单

| 迁移 | 是否必要 | 兼容方案 |
| --- | --- | --- |
| 三类 settings 明文 secret -> main-only safeStorage sidecar + 非敏感引用 | P0 必要 | settings 只保留 entry/version/state；sidecar journal 走 prepare/activate/finalize，成功验证后清理明文，失败保留完整旧状态；普通备份排除 vault，历史备份生成脱敏替代副本。 |
| profile 原子记录/activeProfileId/credentialVersion | P0/P1 必要 | public profile 可先用单 JSON value + SQLite 事务；跨 sidecar 更新按可恢复 journal，不宣称跨文件事务。旧独立 keys 只读兼容一个版本。 |
| 统一 `task_jobs/task_items` scheduler | 跨模块必要 | 由模块 02/03 一次 additive 建表；AI 注册 kind，不重复建队列。 |
| run active pointer、attempt/idempotency key、唯一索引 | P1 必要 | 先扫描重复并备份；保留 duplicate/merged audit，不直接删除用户记录。 |
| 持久 `ResearchAggregateArtifact` | P1 必要 | 模块 06 从 TTL snapshot 提升 criteria/generation/exactness/result payload+hash；被 record/output 引用时按引用计数保留，旧客户端忽略。 |
| record review/version/audit + evidence/aggregate provenance | P1 必要 | 独立不可变版本/audit 结构；旧 record 投影 version 1/pending，不能用可覆写 metadata 冒充历史。 |
| output version/parent relation + record-set/input coverage/claim manifests | P1 必要 | manifests 作为 immutable cursor/chunk artifacts；旧 output 投影 version 1，content 与 v1 snapshot 原样保留并标 legacy，正式 v2 使用不可变 lineage。 |
| canonical evidence verification/backfill | P1 必要 | 小批 cursor 追加 precision/resolution/verificationStatus 和 normalized locator；旧值不覆盖，未完成标 migration-pending。 |
| claim matrix UI、entity、recipe、inbox workflow 新功能表 | P3 可选 | 最小 claim manifest 和共享 evidence relation 已属核心；高级矩阵、实体、配方与 inbox UI 各自单独审批和 additive migration。 |

每个迁移必须执行：schema/磁盘/foreign key 预检；在用户可见位置创建自动备份；`BEGIN IMMEDIATE` 或等价短事务；带 migration ID/cursor/heartbeat 的幂等小批；apply twice；每个写入点故障注入；完成后的 row count/hash/`foreign_key_check`；失败回滚和备份恢复演练。凭据迁移的备份必须脱敏并配合 encrypted recovery journal，不能复制明文数据库。大型文库只能降低批次与优先级，不能跳过正确性迁移。

### 10.3 隐私与外部服务

- operation preview 明确列出将发送的内容类型：问题、选中文字、证据片段、文献卡片、结构化记录或报告草稿；不使用模糊“AI 将处理内容”代替。
- 默认只发送完成任务所需的最小 evidence pack，不发送全部数据库、文件路径、用户文件夹名、标签私密备注、未选中项目或凭据。
- endpoint、provider 和 model 在任务开始时冻结；重定向不得把 Authorization header 转发到不同 origin。响应、错误 body 和 SSE 日志执行 redaction 与长度上限。
- 本地/远程模式、数据外传确认和保留策略作为用户设置，但 secret 安全、verified evidence/aggregate provenance 和正式报告人工 gate 不能被关闭。
- 研究 JSON/Markdown/CSV 导出可能包含原文摘录和研究备注，导出前显示内容范围；普通程序日志和诊断包不得包含这些正文。

### 10.4 实施前必须再次获得用户确认的候选

- 任意本地模型运行时、模型权重、GPU/CPU 推理框架或自动下载器。
- embedding/reranker、向量数据库、全文检索替代服务或 agent framework。
- 外部实体、地名、纪年、学术知识库、地图、价格/账单、同步或通知服务。
- 新 tokenizer、diff、图谱、可视化或数据验证依赖；若现有工具可完成 MVP，优先不引入。
- 将正文、证据、提示词、使用统计或运行记录发送到当前用户配置 AI endpoint 以外的任何服务。

确认材料必须列出：用户收益、替代方案、许可证、维护活跃度、Windows 包体/原生模块、CPU/GPU/内存、网络与隐私、数据格式、升级/卸载、离线能力和回退。用户确认只授权该候选及说明范围，不自动授权其他服务。

### 10.5 开源与发布审批

- 公开仓库不能包含真实 Key、endpoint 私密路径、文献 ID、私有语料词典、用户 prompt/报告、数据库、日志或本地绝对路径。
- 新模板、词典、模型、知识库和二进制资源逐项记录来源、版本、许可证、NOTICE、下载/打包方式与安全更新策略。
- mock provider 和 fixtures 使用中立、合成语料；不得复制用户真实研究材料来提高测试真实性。
- 本章实施过程只允许本地分支、提交和标签。用户本地验收通过并明确批准公开前，不执行任何远程 Git/GitHub/Release 动作。

## 11. 与其他模块的约束

- **模块 01 产品与架构：** renderer-facing AI 能力必须同步 shared、preload、main IPC 和 renderer；typed settings/CredentialVault 拥有 credential entry/version/tombstone/journal；AI job 复用闭合 `TaskStatus=queued|running|paused|completed|error|canceled`，secret、worker 边界和错误 envelope 纳入架构层级门禁。
- **模块 02 导入与入库：** AI job 复用唯一 scheduler、lease、cursor 和资源优先级。导入/OCR 入队不能因后台 AI 队列过长而丢失或被饿死。
- **模块 03 OCR 与校对：** 只有 active OCR/proof artifact 能进入 `CanonicalContentProvider.resolvePage(...) -> CanonicalPageContent`；版本切换使旧 evidence/cache stale。LLM、视觉 OCR 与 PaddleOCR credential 使用同一 vault 和 P0 迁移策略。
- **模块 04 文库组织：** folder/tag/document/project scope 由关系和 generation 表示；AI 不把前 1000 个 ID 当完整 scope。标签多选 AND、文件夹多选/后代 OR 等语义必须与文库/检索一致。
- **模块 05 阅读器：** selection、page、block、OCR box、ebook href 与 translation unit 使用 StableReaderLocator；locator 内的 documentId/sourceHash/contentVersion/offsetUnit/sourceRanges/quote/prefix/suffix 是唯一身份字段，AI 不重复保存平行副本，也不能用关键词首个 occurrence 猜位置。
- **模块 06 全库与全文检索：** AI 只能消费 SearchCriteria、execution-time SearchSnapshot、canonical hit、持久 `ResearchAggregateArtifact` 和 `SearchEvidenceResolver`；precision/resolution/verificationStatus 共用一个 shared 类型。模块 06 负责 aggregate artifact 创建/校验、证据检索/证据篮入口和 entity query projection，模块 07 负责引用、ResearchEvidence annotation 与实体台账，不重复建表。AI sampled stats 不能覆盖检索 exact totals。
- **模块 08 UI 视觉：** AI 面板和研究工作台保持安静、密集、可扫描；scope、provider、外传、coverage、review 和 job 状态使用统一视觉 token，不把研究流程做成营销卡片堆叠。
- **模块 09 交互与工作区：** tabs、项目切换、窗口恢复、拖拽选择、快捷键、latest-request-wins、undo/回收站和焦点规则统一；AI 流不能跨 workspace generation 更新旧页面。
- **模块 10 翻译、引用、导出与写作：** translation evidence 保持 sourceKind/unit；引用和导出只消费 verified evidence/aggregate provenance；报告版本与写作草稿共享 claim/provenance lineage，不复制不可追溯文本。
- **模块 11 数据库与备份：** vault sidecar 默认不进入普通数据库备份；manifest 记录 credential-required 状态。所有 database maintenance 注册到唯一 task scheduler，不能另建 maintenance queue。job lease、aggregate/manifest artifact、record/output version、resolver migration、历史含密钥备份替换和删除策略进入备份/恢复/完整性检查；大库必需迁移不能被维护 skip。
- **模块 12 性能、测试与发布：** 使用 AI-01 至 AI-56 的分层门禁，固定机器记录资源；旧源码字符串通过不能代替行为。发布继续受用户本地验收门禁约束。
- **模块 13 新功能路线：** 本章 9 项新功能按前置依赖、成本、风险排序；NF-04 复用唯一 ResearchEntity，NF-09 只增加 inbox workflow，NF-06 只增加交互审计，不重复核心 evidence/claim/output 表。模块 13 只做统一排期和取舍。
- **模块 14 全局复核：** 必须重点核对 `CanonicalContentProvider.resolvePage -> CanonicalPageContent`、`StableReaderLocator`、`SearchEvidenceResolver` 的正交状态、`task_jobs/task_items`、CredentialVault sidecar/journal、record/aggregate provenance、claim manifest 和 output snapshot；最终只能保留一个权威合同。
