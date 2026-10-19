/**
 * Ollama 本地模型 Provider（API 型）
 *
 * 与 web 型 Provider 的区别：
 *  - 不加载远端网页，改为加载内置聊天页 src/ui/local-chat.html
 *  - 该页面自己调 Ollama /api/chat，并把结果以 cuckoo-ai-response 事件派发给 bridge
 *  - 因此复用 bridge 的工具调用/overlay/会话能力，无需网络拦截
 *
 * 页面 URL 形如：
 *   file:///.../src/ui/local-chat.html?apiBase=http://127.0.0.1:11434&model=qwen2:latest
 */

const ollama = {
  id: 'ollama',
  name: 'Ollama 本地',
  type: 'api' as const,
  apiBase: 'http://127.0.0.1:11434',
  defaultModel: '',
  useIntercept: true,

  // 该字段在 api 型下不用于导航，仅为满足 Provider 校验/信息展示
  homeUrl: 'http://127.0.0.1:11434',
  sessionUrlBase: 'http://127.0.0.1:11434',

  /** 本地聊天页的输入框 */
  findInput() {
    const el = document.querySelector('#lc-input') as any;
    return el || null;
  },

  /** 本地聊天页的发送按钮 */
  findSendButton() {
    const el = document.querySelector('#lc-send') as any;
    if (!el || el.disabled) return null;
    return el;
  },

  extractUserInfo() {
    return '';
  },

  homeUrlPattern: /^file:.*local-chat\.html/i,

  extractSessionId(_url: string): string | null {
    return null;
  },

  matchesUrl(url: string) {
    if (!url) return false;
    return url.indexOf('local-chat.html') !== -1;
  },

  isElementVisible(el: any) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  /**
   * 发送：直接点按钮即可（页面监听 click 发起请求）。
   * 返回 true 表示已处理，避免 fallback 去模拟 Enter（textarea 里 Enter 是换行）。
   */
  triggerSend(_input: any): boolean {
    const btn = document.querySelector('#lc-send') as any;
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    return false;
  },
};

export { ollama };
