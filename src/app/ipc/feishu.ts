/**
 * IPC：飞书同步
 *  - 配置读写 / 启停 / 状态查询（壳页面「飞书」页调用）
 *  - 接收 AI 页面上报（feishu-report）→ 按配置推送飞书
 *  - 飞书来消息 → 转发给当前活跃窗口的 AI 页面
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import * as feishuClient from '../../feishu/client.js';
import { readConfig, writeConfig } from '../../feishu/config.js';
import { getProfileById, getProfileByFeishuChat, setProfileFeishuChat } from '../profile.js';
import { hasRunningSubagent } from '../subagent.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

let feishuInited = false;

// ===== 任务状态卡片（每窗口一张，原地更新）=====
interface TaskState {
  /** 飞书消息 ID（用于原地更新） */
  messageId: string;
  /** 绑定的群 */
  chatId: string;
  /** 任务标题（用户消息摘要） */
  title: string;
  /** 当前阶段 */
  stage: feishuClient.TaskStage;
  /** 阶段详情 */
  detail?: string;
  /** 开始时间戳 */
  startedAt: number;
  /** 已完成的操作记录 */
  history: string[];
  /** 心跳定时器 */
  heartbeat?: any;
}
/** profileId → 当前任务状态 */
const taskStates = new Map<string, TaskState>();

/** 渲染阶段为简短描述（用于 history） */
function stageLabel(stage: feishuClient.TaskStage, detail?: string): string {
  if (stage === 'tool') return '🔧 ' + (detail || '工具');
  if (stage === 'thinking') return '🤔 思考中';
  if (stage === 'done') return '✅ 完成';
  if (stage === 'failed') return '❌ 失败' + (detail ? '：' + detail : '');
  return '▶️ 开始';
}

/** 推送/更新某窗口的任务状态卡片 */
async function syncTaskCard(profileId: string, patch: Partial<TaskState> & { title?: string }): Promise<void> {
  const cur = taskStates.get(profileId);
  if (!cur) return;
  if (patch.stage) cur.stage = patch.stage;
  if (patch.detail !== undefined) cur.detail = patch.detail;
  if (patch.title) cur.title = patch.title;
  // history 由调用方直接 push
  const status: feishuClient.TaskStatusCard = {
    title: cur.title,
    stage: cur.stage,
    detail: cur.detail,
    elapsedSec: (Date.now() - cur.startedAt) / 1000,
    history: cur.history,
  };
  const r = await feishuClient.updateStatusCard(cur.messageId, status);
  if (!r.success) {
    console.warn('[Feishu] 状态卡片更新失败:', r.error, '（将降级为新发消息）');
    // 降级：发新消息
    const nr = await feishuClient.sendStatusCard(status, cur.chatId);
    if (nr.success && nr.messageId) cur.messageId = nr.messageId;
  }
}

/** 结束任务并清理心跳 */
function endTask(profileId: string): void {
  const cur = taskStates.get(profileId);
  if (!cur) return;
  if (cur.heartbeat) {
    clearInterval(cur.heartbeat);
    cur.heartbeat = undefined;
  }
  // 保留 60 秒后清理，避免内存泄漏
  setTimeout(() => {
    const t = taskStates.get(profileId);
    if (t && t.stage !== 'running' && t.stage !== 'thinking' && t.stage !== 'tool') {
      taskStates.delete(profileId);
    }
  }, 60000);
}

/** 心跳间隔（毫秒）：60 秒 */
const HEARTBEAT_MS = 60000;

/**
 * 飞书来消息 → 按 chatId 找到"绑定了该群的窗口" → 转发给它的 AI 页面。
 * - 群消息（chatId 非空）：只发给绑了该群的窗口
 * - 单聊（chatId 为空）：回退给最近活跃窗口
 */
function forwardUserMessage(text: string, chatId: string): void {
  let ctx: any = null;
  if (chatId) {
    const profile = getProfileByFeishuChat(chatId);
    if (!profile) {
      console.warn('[Feishu] 收到群消息，但没有窗口绑定该群，丢弃。chatId=' + chatId);
      return;
    }
    ctx = windowState.getWindowByProfileId(profile.id);
    if (!ctx) {
      console.warn('[Feishu] 群已绑定 profile，但该窗口未打开，丢弃。profileId=' + profile.id);
      return;
    }
  } else {
    ctx = windowState.getMainContext();
  }
  // 子代理运行期间：拒收（避免插进正在进行的 AI 循环），并回一条提示
  try {
    if (ctx && ctx.profileId && hasRunningSubagent(ctx.profileId)) {
      console.log('[Feishu] 子代理运行中，拒收飞书消息并回提示');
      feishuClient.sendText('AI 正在使用子代理执行任务，请等子代理结束后再发消息。', chatId || undefined).catch(() => {});
      return;
    }
  } catch (_) { /* ignore */ }
  const view = ctx && ctx.view;
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    console.warn('[Feishu] 目标窗口不可用，消息丢弃');
    return;
  }
  try {
    view.webContents.send('feishu-user-message', { text });
    console.log('[Feishu] 已转发消息到 AI 页面, 长度=' + text.length + (chatId ? ' (群)' : ' (活跃窗口)'));
  } catch (err: any) {
    console.error('[Feishu] 转发失败:', err.message);
  }
}

/** 通知所有 AI 页面：飞书启用状态（bridge 据此决定是否上报） */
function broadcastFeishuMode(enabled: boolean): void {
  for (const ctx of windowState.getAllContexts()) {
    try {
      const v = ctx && ctx.view;
      if (v && v.webContents && !v.webContents.isDestroyed()) {
        v.webContents.send('feishu-mode', { enabled });
      }
    } catch (_) {}
  }
}

/** 初始化飞书（启动时调用：若配置为启用则自动连接） */
function initFeishu(): void {
  if (feishuInited) return;
  feishuInited = true;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.appId || !cfg.appSecret) return;
  feishuClient.connect({
    onUserMessage: (text, chatId) => forwardUserMessage(text, chatId),
  });
  broadcastFeishuMode(true);
  console.log('[Feishu] 启动时自动连接（已启用）');
}

function registerFeishuIpc(): void {
  // bridge 初始化时查询启用状态（避免错过广播时机）
  ipcMain.handle('feishu-is-enabled', async () => {
    const cfg = readConfig();
    return { enabled: cfg.enabled === true && !!cfg.appId && !!cfg.appSecret };
  });

  // 读配置 + 状态
  ipcMain.handle('feishu-get-config', async () => {
    const cfg = readConfig();
    const st = feishuClient.getStatus();
    // 不把 appSecret 明文回传（用掩码）
    return {
      success: true,
      config: {
        appId: cfg.appId,
        appSecret: cfg.appSecret ? '••••••' : '',
        hasSecret: !!cfg.appSecret,
        enabled: cfg.enabled,
        targetOpenId: cfg.targetOpenId,
        hasTarget: !!cfg.targetOpenId,
        pushUserMessage: cfg.pushUserMessage,
        pushAiReply: cfg.pushAiReply,
        pushToolStatus: cfg.pushToolStatus,
        pushToolName: cfg.pushToolName,
      },
      status: st.status,
      statusDetail: st.detail,
    };
  });

  // 保存配置 + （按需）启停连接
  ipcMain.handle('feishu-save-config', async (_event: any, { data }: any) => {
    const before = readConfig();
    const d: any = { ...(data || {}) };
    // 掩码密码不回写（保留原值）
    if (d.appSecret === '••••••') delete d.appSecret;
    const ok = writeConfig(d);
    if (!ok) return { success: false, error: '保存失败' };
    const cfg = readConfig();
    // 仅当"凭证或启用状态"变化时才重连（纯改推送选项不重连）
    const connChanged = before.appId !== cfg.appId
      || before.appSecret !== cfg.appSecret
      || before.enabled !== cfg.enabled;
    if (!connChanged) return { success: true };
    // 按启用状态连接/断开
    if (cfg.enabled && cfg.appId && cfg.appSecret) {
      feishuClient.connect({ onUserMessage: (text, chatId) => forwardUserMessage(text, chatId) });
      broadcastFeishuMode(true);
    } else {
      feishuClient.disconnect();
      broadcastFeishuMode(false);
    }
    return { success: true };
  });

  // 查询机器人所在的群列表（供窗口下拉选择绑定）
  ipcMain.handle('feishu-list-chats', async () => {
    return await feishuClient.listChats();
  });

  // 读取当前窗口绑定的群
  ipcMain.handle('feishu-get-binding', async (event: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profile = ctx ? getProfileById(ctx.profileId) : null;
    return {
      success: true,
      chatId: (profile && profile.feishuChatId) || '',
      chatName: (profile && profile.feishuChatName) || '',
      profileId: ctx ? ctx.profileId : '',
    };
  });

  // 绑定/解绑当前窗口的群
  ipcMain.handle('feishu-bind-chat', async (event: any, { chatId, chatName }: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.profileId) return { success: false, error: '找不到窗口' };
    const p = setProfileFeishuChat(ctx.profileId, chatId || '', chatName || '');
    if (!p) return { success: false, error: '更新失败' };
    return { success: true };
  });

  // 手动重连
  ipcMain.handle('feishu-reconnect', async () => {
    const cfg = readConfig();
    if (!cfg.appId || !cfg.appSecret) return { success: false, error: '未配置凭证' };
    feishuClient.connect({ onUserMessage: (text, chatId) => forwardUserMessage(text, chatId) });
    return { success: true };
  });

  // 断开
  ipcMain.handle('feishu-disconnect', async () => {
    feishuClient.disconnect();
    broadcastFeishuMode(false);
    return { success: true };
  });

  // AI 页面上报（用户消息 / AI 回复 / 工具状态）→ 按"发起窗口绑定的群"推送
  ipcMain.handle('feishu-report', async (event: any, payload: any) => {
    const cfg = readConfig();
    if (!cfg.enabled) return { success: false };
    // 从发起方（AI 页面）反查窗口 → 取该窗口绑定的群
    const ctx = windowState.getContextByWebContents(event.sender);
    const profile = ctx ? getProfileById(ctx.profileId) : null;
    const chatId = (profile && profile.feishuChatId) || '';
    // 未绑定群时允许单聊回退（sendText/sendStatusCard 内部会用 targetOpenId）
    if (!chatId && !cfg.targetOpenId) {
      return { success: false, error: 'no-chat-bound' };
    }
    const type = payload && payload.type;
    // 统一推送 + 结果检查（失败打日志，便于排查）
    const push = async (text: string, label: string) => {
      const r = await feishuClient.sendText(text, chatId);
      if (!r.success) console.warn('[Feishu] 推送失败（' + label + '）:', r.error);
      return r;
    };
    // Markdown 推送（AI 回复用，渲染 MD）
    const pushMd = async (md: string, label: string) => {
      const r = await feishuClient.sendMarkdown(md, chatId);
      if (!r.success) console.warn('[Feishu] 推送失败（' + label + '）:', r.error);
      return r;
    };
    const profileId = (ctx && ctx.profileId) || '';
    try {
      if (type === 'user-message') {
        if (!cfg.pushUserMessage) return { success: true };
        const t = String(payload.text || '').trim();
        if (!t) return { success: true };
        // 用户发新消息 = 新任务开始：先推送用户消息，再创建状态卡片
        await push('👤 我：' + t, 'user-message');
        // 若已有旧任务，先结束它
        if (profileId && taskStates.has(profileId)) endTask(profileId);
        if (profileId) {
          const title = t.length > 40 ? t.slice(0, 40) + '…' : t;
          const init: feishuClient.TaskStatusCard = { title, stage: 'running', elapsedSec: 0, history: ['▶️ 开始'] };
          const created = await feishuClient.sendStatusCard(init, chatId);
          if (created.success && created.messageId) {
            const st: TaskState = {
              messageId: created.messageId,
              chatId,
              title,
              stage: 'running',
              startedAt: Date.now(),
              history: ['▶️ 开始'],
            };
            // 心跳：每分钟更新已运行时长
            st.heartbeat = setInterval(() => {
              const cur = taskStates.get(profileId);
              if (!cur) return;
              feishuClient.updateStatusCard(cur.messageId, {
                title: cur.title,
                stage: cur.stage,
                detail: cur.detail,
                elapsedSec: (Date.now() - cur.startedAt) / 1000,
                history: cur.history,
              }).catch(() => {});
            }, HEARTBEAT_MS);
            taskStates.set(profileId, st);
          }
        }
        return { success: true };
      } else if (type === 'ai-reply') {
        if (!cfg.pushAiReply) return { success: true };
        const t = String(payload.text || '').trim();
        if (!t) return { success: true };
        await pushMd('**🤖 AI：**\n\n' + t, 'ai-reply');
        // 任务完成：更新状态卡片
        if (profileId && taskStates.has(profileId)) {
          const cur = taskStates.get(profileId)!;
          cur.history.push('✅ 完成');
          await syncTaskCard(profileId, { stage: 'done' });
          endTask(profileId);
        }
        return { success: true };
      } else if (type === 'tool-start') {
        if (!cfg.pushToolStatus) return { success: true };
        const toolName = String((payload && payload.toolName) || '').trim();
        const label = toolName ? (cfg.pushToolName ? toolName : '工具') : '工具';
        // 更新状态卡片（不单独发消息，避免刷屏）
        if (profileId && taskStates.has(profileId)) {
          const cur = taskStates.get(profileId)!;
          cur.history.push(stageLabel('tool', toolName || ''));
          await syncTaskCard(profileId, { stage: 'tool', detail: label });
          return { success: true };
        }
        // 无任务卡片时，降级为独立消息
        return await push('🔧 AI 正在调用工具…', 'tool-start');
      } else if (type === 'tool-end') {
        if (!cfg.pushToolStatus) return { success: true };
        // 工具结束 → 回到思考阶段（不单独发消息）
        if (profileId && taskStates.has(profileId)) {
          await syncTaskCard(profileId, { stage: 'thinking', detail: '' });
          return { success: true };
        }
        return { success: true };
      } else if (type === 'task-error') {
        // 任务失败（由 bridge 在 AI 出错时上报）
        if (profileId && taskStates.has(profileId)) {
          const cur = taskStates.get(profileId)!;
          const errMsg = String((payload && payload.error) || '未知错误');
          cur.history.push('❌ ' + errMsg);
          await syncTaskCard(profileId, { stage: 'failed', detail: errMsg });
          endTask(profileId);
        }
        return { success: true };
      }
    } catch (err: any) {
      console.error('[Feishu] 推送异常:', err.message);
      return { success: false, error: err.message };
    }
    return { success: true };
  });
}

export { registerFeishuIpc, initFeishu, broadcastFeishuMode };
