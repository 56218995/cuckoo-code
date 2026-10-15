---
id: 028
type: feature
title: 用户记忆功能默认关闭 + 开关
status: review
branch: feat/028-memories-default-off
created: 2026-10-15
updated: 2026-10-15
---

## 背景

PR #40 引入用户记忆系统（remember/forgetMemory 工具 + 正文 [记忆]xxx 标记 + 系统提示词注入），**默认启用**。

用户要求：**默认关闭**该功能，并提供开关。

## 目标

- 记忆功能**默认关闭**（新用户无配置时视为关闭）
- 提供 UI 开关（记忆页顶部）
- 关闭时完全生效：工具列表隐藏 + 工具说明不注入 + 记忆章节不注入 + 标记不捕获 + 工具调用拒绝
- 已有记忆数据**保留**（开启后仍在）

## 方案

### 配置存储

新建 `~/.cuckoo/config.json`（全局用户配置）：
```json
{ "memoriesEnabled": false }
```
- 默认 false（文件不存在时）
- 新增 `src/infra/config.ts`：`isMemoriesEnabled()` / `setMemoriesEnabled()`

### 5 个环节（关闭时全部生效）

1. **工具列表/说明**：给 `Tool` 加 `isEnabled()` 钩子（默认 true），`ToolRegistry.getDescriptions()`/`getPromptSections()` 过滤；`remember`/`forgetMemory` override 返回 `isMemoriesEnabled()`
2. **记忆章节注入**：`buildMemorySection()` 关闭时返回空串（不注入 `{{MEMORY_SECTION}}`）
3. **正文标记捕获**：`app/ipc/memory.ts` 的 `create-memory-marker` handler 关闭时拒绝
4. **工具调用**：`remember`/`forgetMemory` 的 `execute()` 关闭时返回「记忆功能已关闭」
5. **UI**：记忆页顶部开关（`mem-enabled` checkbox）

### IPC
- `get-memories-enabled` / `set-memories-enabled`

## 验收标准

- [ ] 默认（无 config.json）时记忆功能关闭
- [ ] 关闭时：工具列表无 remember、提示词无记忆章节、标记不捕获、调用被拒
- [ ] 开启后功能恢复，已有记忆还在
- [x] typecheck / compile / test（913 passed）全绿

真机验证方式：重启应用 → 打开记忆页 → 默认开关关闭；开启后验证 remember 工具可用；关闭后验证不可用。

## 遗留 / 后续

- **`{{TOOL_API_TYPES}}` 无法过滤**：工具类型定义（api.d.ts）是构建期静态文件，关闭时 AI 仍能看到 `remember`/`forgetMemory` 签名（但它们不在工具列表里）。影响小：AI 无理由调用不在列表的函数，且调用会被 `execute()` 拒绝。
- 开关位置：当前在「记忆页」顶部（从左侧菜单「记忆」进入）。若要更显眼（菜单项旁直接切换）需另做。
