/**
 * ChatGPT Provider 定义
 * 基于 chatgpt.com 页面结构，输入框为 ProseMirror（contenteditable）。
 */
import { CHATGPT_HOOK } from './generated/hook-sources.js';

const chatgpt = {
  id: 'chatgpt',
  name: 'ChatGPT',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  homeUrl: 'https://chatgpt.com/',
  sessionUrlBase: 'https://chatgpt.com/c/',

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el: any) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见的聊天输入框（ChatGPT 用 ProseMirror contenteditable）
  findInput() {
    const selectors = [
      'div[contenteditable="true"].ProseMirror',
      'div[role="textbox"]',
      'div.ProseMirror',
      'div[contenteditable="true"]',
      'textarea',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (this.isElementVisible(el)) return el;
      } catch (_) {}
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="发送提示词"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
    ];
    for (const sel of selectors) {
      try {
        const btn = document.querySelector(sel) as any;
        if (this.isElementVisible(btn) && !btn.disabled) return btn;
      } catch (_) {}
    }
    return null;
  },

  // 填入输入框：ChatGPT 的 ProseMirror 会把 ClipboardEvent('paste') 识别为
  // "粘贴的文件"附件（出现 .txt 卡片），文本区却为空 → 发送空内容。
  // 改用 execCommand('insertText') 直接写文本节点，与真实打字等价。
  fillInput(input: any, text: string) {
    // ChatGPT 的 ProseMirror 会在「同一条流内」多次下发；填入用 execCommand('insertText')。
    // ⚠️ 页面导航/重渲染期间（如初始化时新建会话），execCommand 会「静默失败」
    //   （返回 false，或写进去被 React 冲掉）→ 必须读回校验 + 内部密集探测重试，
    //   否则会退化成外层 500ms×N 的硬等（初始化等待 10s+）。
    const probe = text.replace(/\s+/g, '');

    // 单次写入尝试：清空 → 分段插入 → 读回校验
    const writeOnce = (): boolean => {
      try {
        input.focus();
        // 清空现有内容
        try {
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(input);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('delete', false, undefined);
          }
        } catch (_) {}
        // 分段插入（长文本 execCommand 单次可能失败）
        const CHUNK = 5000;
        for (let i = 0; i < text.length; i += CHUNK) {
          document.execCommand('insertText', false, text.slice(i, i + CHUNK));
        }
        // 读回校验：去空白后长度 ≥ 期望的 90%
        const written = String(input.innerText || input.textContent || '').replace(/\s+/g, '');
        return written.length >= probe.length * 0.9;
      } catch (_) {
        return false;
      }
    };

    return (async () => {
      // 内部密集探测：每 200ms 一次，页面一稳定立即成功；上限 3s 后交回外层。
      // 正常情况首次即成功（无额外开销），仅导航期才进入重试分支。
      const deadline = Date.now() + 3000;
      let attempt = 0;
      for (;;) {
        // input 被 React 替换（脱离 DOM）→ 重试无意义，立即交回外层重新查找
        if (!input.isConnected) {
          if (attempt > 0) console.warn('[Cuckoo Code][chatgpt.fillInput] input 已脱离 DOM，交回外层');
          return false;
        }
        if (writeOnce()) {
          try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
          if (attempt > 0) console.warn('[Cuckoo Code][chatgpt.fillInput] 第 ' + attempt + ' 次重试后填入成功');
          return true;
        }
        attempt++;
        if (Date.now() >= deadline) {
          console.warn('[Cuckoo Code][chatgpt.fillInput] 3s 内未填入成功，交回外层重试');
          return false;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  },

  // 触发发送。ChatGPT 的 ProseMirror 免疫合成 KeyboardEvent；
  // 且**主进程 sendInputEvent 的键盘事件依赖页面有焦点**——用户焦点在壳窗口/别的窗口时
  // （document.hasFocus() === false），Enter 会送不到页面 → 消息发不出去。
  // 故优先用**真实鼠标点击发送按钮**（sendInputEvent 鼠标事件不受焦点影响），
  // 点击后校验输入框是否被清空（发送成功的标志），失败再回退 Enter / DOM click。
  async triggerSend(input: any) {
    const api = (window as any).electronAPI;
    // 重新查找发送按钮（发送延迟期间 DOM 可能已变化）
    const btn = this.findSendButton ? this.findSendButton() : null;

    // 1) 优先：主进程真实鼠标点击发送按钮（不受页面/窗口焦点影响）
    if (btn && api && typeof api.simulateMouse === 'function') {
      try {
        if (input && typeof input.focus === 'function') { try { input.focus(); } catch (_) {} }
        const rect = btn.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        await api.simulateMouse('click', x, y);
        // 校验：发送成功 → ChatGPT 会清空输入框
        await new Promise((res) => setTimeout(res, 400));
        const remaining = String((input && (input.innerText || input.textContent)) || '').replace(/\s+/g, '').length;
        if (remaining <= 2) return true;
        console.warn('[Cuckoo Code][chatgpt.triggerSend] 鼠标点击后输入框未清空(remaining=' + remaining + ')，转 Enter 兜底');
      } catch (err: any) {
        console.warn('[Cuckoo Code][chatgpt.triggerSend] 鼠标点击失败:', err && err.message);
      }
    }

    // 2) 兜底：主进程真实 Enter（需页面有焦点）
    try {
      if (input && typeof input.focus === 'function') { try { input.focus(); } catch (_) {} }
      if (api && typeof api.sendEnterToChat === 'function') {
        const ok = await api.sendEnterToChat();
        if (ok) return true;
      }
    } catch (_) { /* 继续回退 */ }

    // 3) 最后兜底：DOM click
    if (btn) { (btn as any).click(); return true; }
    return false;
  },

  // 提取当前用户信息文本
  // 优先从 localStorage 的 accountSwitchSessions 读取（稳定，不受 DOM 渲染影响）；
  // 失败再回退到侧边栏 DOM 提取。
  extractUserInfo() {
    // 1. localStorage: oai/apps/accountSwitchSessions -> [0].name
    try {
      const raw = localStorage.getItem('oai/apps/accountSwitchSessions');
      if (raw) {
        const sessions = JSON.parse(raw);
        if (Array.isArray(sessions) && sessions.length > 0 && sessions[0].name) {
          return String(sessions[0].name).trim();
        }
      }
    } catch (_) {}

    // 2. 优先用常见按钮选择器
    const btn = document.querySelector('[data-testid="profile-button"]') ||
      document.querySelector('button[aria-label*="profile" i]') ||
      document.querySelector('button[aria-label*="account" i]');
    if (btn) {
      const aria = btn.getAttribute('aria-label') || '';
      if (aria) return aria.trim();
    }

    // 3. 侧边栏底部用户区：class 含 z-30 的底部固定容器
    const containers = document.querySelectorAll('nav div[class*="z-30"]');
    for (const el of containers) {
      const clone = el.cloneNode(true) as any;
      clone.querySelectorAll('button').forEach((b: any) => b.remove());
      const text = (clone.textContent || '').trim();
      if (text && text !== 'ChatGPT' && text.length <= 40) {
        return text;
      }
    }
    return '';
  },

  // 首页判断正则（https://chatgpt.com/ 或 https://chatgpt.com）
  homeUrlPattern: /^https:\/\/chatgpt\.com\/?$/,

  // 从 URL 提取会话 ID（ChatGPT 正式会话是 /c/{uuid} 格式）。
  // 注意：创建会话过程中 URL 有中间态 /c/WEB:xxx、/c/local-chatgpt 等，
  // 这些不是真实会话 ID。若误把它们当会话 ID 返回，session-store 会据此
  // 绑定 projectDir 并清空 pendingProjectDir，导致真正会话 ID 出现时
  // 项目目录丢失（表现为"初始化后 GPT 拿不到项目目录"）。
  // 故此处只认完整 UUID，中间态一律返回 null。
  extractSessionId(url: string): string | null {
    if (!url) return null;
    const uuidMatch = url.match(/\/c\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    return uuidMatch ? uuidMatch[1] : null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url: string) {
    return url.includes('chatgpt.com') || url.includes('chat.openai.com');
  },

  // 返回注入主世界的网络拦截器源码（拦截模式使用）
  // 源码由 scripts/build-hooks.mjs 从 hooks/chatgpt.ts 打包生成（自包含 IIFE）
  getHookSource() {
    return CHATGPT_HOOK;
  },
};

export { chatgpt };

