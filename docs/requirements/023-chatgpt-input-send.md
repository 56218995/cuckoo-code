---
id: 023
type: fix
title: ChatGPT 初始化填入失败 + 工具结果发送失败
status: review
branch: fix/023-chatgpt-input-send
created: 2026-10-13
updated: 2026-10-13
---

## 背景

ChatGPT 平台出现两个阻断性问题：

1. **初始化项目后系统提示词填不进去 / 要等很久 / 有时不发送**
   - 日志：`输入框写入校验失败：期望约 19873 字，实际 0 字` 连续 21 次，第 22 次才成功（≈10.5s）；
     重试到上限 30 次仍失败则放弃（表现为「不发送」）。
2. **工具执行完，回传结果卡在输入框发不出去**
   - 日志：`已通过站点原生发送触发` 之后无后续（消息实际没发出去）。

## 目标

- ChatGPT 初始化时系统提示词能**快速、可靠**填入并发出
- 工具执行结果回传后能**自动发出**（不再卡在输入框）

## 方案

### 一、findInput 改用 querySelectorAll 遍历找可见元素（问题 1 根因）

**根因**：ChatGPT 页面同时存在**多个** `.ProseMirror`（首页含隐藏的模板编辑器）。
`document.querySelector` 只返回**第一个匹配** → 命中**隐藏**元素 → `execCommand('insertText')`
往隐藏元素写 → 静默失败（实测 `insertRet: false`，内容为空）。

**修复**（`src/providers/chatgpt.ts`）：`findInput` 用 `querySelectorAll` 遍历，返回第一个**可见**的元素。

**验证**：CDP 实测——往可见的 ProseMirror 写 `insertText` 返回 `true` 且内容写入成功。

### 二、triggerSend 优先真实鼠标点击发送按钮（问题 2 根因）

**根因**：AI 页面无焦点（`document.hasFocus() === false`，用户焦点在壳窗口/别的窗口）时，
主进程 `sendInputEvent` 的**键盘事件送不到页面** → Enter 落空 → 消息发不出去。
且 `chat-send-enter` 无条件 `return true`，把失败吞掉（日志显示「已通过站点原生发送触发」但实际没发）。

**修复**：
- `src/providers/chatgpt.ts` `triggerSend`：优先**真实鼠标点击**发送按钮（鼠标事件不受焦点影响）
  + 点击后校验输入框是否被清空（发送成功标志）；失败回退 Enter；再失败 DOM click
- `src/app/ipc/renderer.ts` `chat-send-enter`：发送前先 `sender.focus()` 让 view 获得键盘焦点

**验证**：Playwright 真实鼠标点击发送按钮 → 输入框从 87 字变 1 字（清空=发送成功）。

### 三、fillInput 加读回校验（防御）

`src/providers/chatgpt.ts` `fillInput`：写入后读回校验（去空白长度 ≥ 期望的 90%），
失败返回 false（而非无条件 true），让上层重试。

## 验收标准

- [ ] ChatGPT 初始化项目：系统提示词快速填入并发出（不再卡 10s+ / 放弃）
- [ ] ChatGPT 工具执行：结果自动发出（不再卡在输入框）
- [x] typecheck / compile / test（873 passed）全绿

真机验证方式：重启应用 → ChatGPT 窗口初始化项目 + 触发工具调用，观察行为与日志。

## 遗留 / 后续

- **问题 2（已记录未修）**：初始化浮动窗口出现「全选/框选」感——疑与 `execCommand('selectAll')` /
  `selectNodeContents(input)` 有关（选中输入框全部内容时可见高亮），待验证。
- **SSE delta 协议完整性**：ChatGPT 用 `delta_encoding: v1`（增量 delta，前端 applyDelta 按 per-channel 累积）；
  当前 hook 用朴素累加，单样本实测可行，但 `remove`/`truncate`/嵌套 patch/per-channel 隔离未实现，
  需多场景采样（重新生成/停止/长回复）后再决定是否补全。
- 详细排查记录见 `docs/prompts/chatgpt-test-log.md`（本地，未入库）。
- `chat-input.ts` 兜底的 `querySelector('div[contenteditable...]')`（L271）有同样的「多匹配」隐患，本次未改。
