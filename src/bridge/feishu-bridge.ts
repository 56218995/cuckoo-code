/**
 * 飞书同步：bridge 侧逻辑（运行在 AI 页面 preload）
 *
 * 职责：
 *   1. 监听"用户消息已发出" → 上报主进程 → 飞书推送
 *   2. 监听 AI 回复完成 → 上报
 *   3. 监听工具调用（start/end）→ 上报（仅状态，不带参数/结果）
 *   4. 接收主进程转发的飞书来消息 → sendToChat 发给 AI
 *
 * 门控：主进程切换飞书启用状态时通知（enabled=false 时各回调立即返回，零开销）。
 */
import { createRequire } from 'node:module';
import { onInterceptedResponse, onToolCall, onAiError } from './intercept/observer.js';
import { sendToChat, onUserMessageSent } from '../overlay/chat-input.js';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

/** 移除文本中的 cuckoo/js 工具代码块（工具调用另行上报，飞书只显示对话） */
export function stripToolBlocks(text: string): string {
  if (!text) return '';
  let out = text;
  out = out.replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*?```/gi, '');
  out = out.replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*$/gi, '');
  out = out.replace(/```(?:cuckoo|javascript|js)\s*$/gi, '');
  return out.trim();
}

function report(payload: any): void {
  try {
    ipcRenderer.invoke('feishu-report', payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

let inited = false;
export function initFeishuBridge(): void {
  if (inited) return;
  inited = true;

  // 启用门控（主进程下发 + 初始化时主动查询，避免错过广播）
  let enabled = false;
  ipcRenderer.on('feishu-mode', (_e: any, payload: any) => {
    enabled = !!(payload && payload.enabled);
    console.log('[Feishu-bridge] 收到模式广播 enabled=' + enabled);
  });
  try {
    ipcRenderer.invoke('feishu-is-enabled').then((r: any) => {
      if (r) enabled = !!r.enabled;
      console.log('[Feishu-bridge] 主动查询 enabled=' + enabled + ' raw=' + JSON.stringify(r));
    }).catch((e: any) => console.log('[Feishu-bridge] 查询失败: ' + (e && e.message)));
  } catch (_) {}

  // 本轮任务是否调用过工具（用户发新消息时重置）
  let usedToolThisTurn = false;

  // 1. 用户消息（经 Cuckoo 发送）→ 上报（并重置本轮工具标记）
  onUserMessageSent((text: string, tag?: string) => {
    console.log('[Feishu-bridge] 用户消息事件 enabled=' + enabled + ' tag=' + (tag || '(空)') + ' len=' + (text ? text.length : 0));
    if (!enabled || !text) return;
    usedToolThisTurn = false;
    report({ type: 'user-message', text: text, tag: tag || '' });
  });

  // 2. AI 回复完成 → 上报（剥离工具代码块，飞书只看对话）
  onInterceptedResponse((text: string) => {
    console.log('[Feishu-bridge] AI回复事件 enabled=' + enabled + ' len=' + (text ? text.length : 0));
    if (!enabled || !text) return;
    let clean = stripToolBlocks(text);
    if (!clean) return;
    // 本轮未调用任何工具 → 末尾附注（便于用户知道可以直接发下一步）
    if (!usedToolThisTurn) clean += '\n\n（本次AI没有调用任何工具）';
    report({ type: 'ai-reply', text: clean });
  });

  // 3. 工具调用状态 → 上报（带上工具名，供状态卡片展示）
  onToolCall((ev: any) => {
    if (!enabled || !ev) return;
    usedToolThisTurn = true;
    if (ev.phase === 'start') report({ type: 'tool-start', toolName: ev.toolName || '' });
    else if (ev.phase === 'end') report({ type: 'tool-end', toolName: ev.toolName || '' });
  });

  // 4. AI 请求失败 → 上报（供状态卡片标记失败）
  onAiError((detail: any) => {
    if (!enabled) return;
    const err = (detail && (detail.reason || detail.text || detail.name)) || 'AI 请求失败';
    report({ type: 'task-error', error: String(err).slice(0, 200) });
  });

  // 4. 飞书来消息 → 主进程转发到此 → 发给 AI
  ipcRenderer.on('feishu-user-message', (_e: any, payload: any) => {
    const text = payload && payload.text;
    if (!text) return;
    sendToChat(text, '飞书', 300).catch(() => {});
  });
}
