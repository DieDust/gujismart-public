# Floating Block Inspector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将版式编辑的“区块属性”改为不参与页面排版的轻量浮窗，尽量减少对底图预览和拖拽编辑的遮挡。

**Architecture:** 保留 `ManualBlockInspector` 的字段、表格编辑和图片编辑逻辑，只调整 `GujiFacsimileProofreader` 的容器层级与 CSS 定位。面板采用 fixed/absolute 浮层，未选中时隐藏，仅保留窄按钮；选中时默认以右侧窄浮窗打开，并允许手动收起。页面画布宽度、坐标换算和 pointer 事件不因面板出现而改变。

**Tech Stack:** React, TypeScript, CSS, Electron renderer, existing manual-layout regression scripts.

---

### Task 1: Add a failing layout contract regression

**Files:**
- Create: `scripts/manual-block-inspector-viewport-regression.js`
- Modify: `package.json`

**Steps:**

1. Assert the inspector is rendered as an overlay and has a collapse control.
2. Assert the layout source does not use the inspector as a flex/grid column that changes page width.
3. Run `node scripts/manual-block-inspector-viewport-regression.js` and verify it fails against the current side-column implementation.

### Task 2: Convert the inspector to a floating overlay

**Files:**
- Modify: `src/renderer/src/components/GujiFacsimileProofreader.tsx`
- Modify: `src/renderer/src/components/ManualBlockInspector.css`

**Steps:**

1. Add local open/closed state for the inspector, defaulting closed when there is no active block.
2. Render a small edge button when closed; render the existing inspector inside a floating overlay when open.
3. Keep all existing callbacks and inspector props unchanged.
4. Use a bounded width (about 300–340px), max-height, and right/top offsets so the panel does not cover the page center.
5. Add a narrow-window fallback that uses a smaller overlay and does not change the page canvas width.
6. Run the regression and typecheck; both should pass.

### Task 3: Verify no behavior regression

Run:

```powershell
npm run typecheck
node scripts/manual-block-inspector-viewport-regression.js
npm run check:facsimile-stacked-vertical-blocks
npm run check:manual-layout
npm run check:mojibake
git diff --check
```

### Task 4: Commit

```powershell
git add docs/plans/2026-08-06-floating-block-inspector.md src/renderer/src/components/GujiFacsimileProofreader.tsx src/renderer/src/components/ManualBlockInspector.css scripts/manual-block-inspector-viewport-regression.js package.json
git commit -m "fix: make manual block inspector floating"
```
