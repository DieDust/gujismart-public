# 表格快捷插入按钮设计与实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在版式编辑的表格视图中，为悬停的行/列提供一个低遮挡的 `＋` 快捷按钮，点击后在其后方插入一行或一列空白。

**Architecture:** 复用 `FacsimileTableEditor` 已有的结构操作命令，不新增数据格式或 IPC。列标题悬停时在标题右侧显示插入列按钮，行标题悬停时在标题底部显示插入行按钮；按钮只负责把悬停索引转换为“右侧/下方插入”命令，因此继续使用当前的合并单元格修正、尺寸数组调整、历史记录和自动保存链路。

**Tech Stack:** React + TypeScript, Ant Design Button/Tooltip, CSS sticky table headers, Node 静态回归脚本。

---

### Task 1: Add hover quick-insert controls

**Files:**
- Modify: `src/renderer/src/components/FacsimileTableEditor.tsx`
- Modify: `src/renderer/src/components/FacsimileTableEditor.css`

**Step 1:** Add column-header and row-header plus controls with explicit aria labels and disabled handling.

**Step 2:** Route each control to insertion-after logic while preserving existing history, merge adjustment, size adjustment, and focus behavior.

**Step 3:** Add compact hover-only styling so controls do not occupy the grid or cover cell content.

### Task 2: Add regression coverage

**Files:**
- Create: `scripts/facsimile-table-quick-insert-regression.js`
- Modify: `package.json`

**Step 1:** Assert the renderer exposes hover-only row/column quick controls and insertion-after actions.

**Step 2:** Exercise the existing pure structure command path to verify row/column insertion preserves table data and reports the correct mutation index.

**Step 3:** Run the focused regression, typecheck, build, and UTF-8 checks.

### Task 3: Package the Windows installer

**Files:**
- No source changes.

**Step 1:** Run `npm run build:win`.

**Step 2:** Run `npm run smoke:packaged` against the generated package.

**Step 3:** Report the exact Setup and Portable installer paths and any non-blocking build warnings.
