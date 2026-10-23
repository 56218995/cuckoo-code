/**
 * 插件背景图渲染（壳页面）
 * 监听 shell-background 事件 → 用多重背景叠加图片 + 半透明遮罩
 *
 * 关键：用 CSS 多重背景而非独立 div 遮罩（后者会被 body 背景盖住）
 */
import { api } from './shared.js';

/** 应用背景（多重背景叠加：遮罩 + 图） */
function applyBackground(data: any): void {
  const body = document.body;
  // 清理旧实现残留的 style 标签（plugin-shell.ts 曾注入，url 无引号含空格会失败）
  const legacy = document.getElementById('ck-plugin-bg');
  if (legacy) legacy.remove();
  if (!data || !data.url) {
    body.style.backgroundImage = '';
    body.style.backgroundSize = '';
    body.style.backgroundPosition = '';
    body.style.backgroundRepeat = '';
    body.style.backgroundAttachment = '';
    return;
  }
  const overlay = data.overlay || 'rgba(10,12,20,0.5)';
  // 多重背景：第一层遮罩，第二层图片
  body.style.backgroundImage = 'linear-gradient(' + overlay + ',' + overlay + '), url("' + String(data.url).replace(/"/g, '\\"') + '")';
  body.style.backgroundSize = '100% 100%, cover';
  body.style.backgroundPosition = '0 0, center center';
  body.style.backgroundRepeat = 'no-repeat, no-repeat';
  body.style.backgroundAttachment = 'scroll, scroll';
  body.style.backgroundOrigin = 'border-box, border-box';
}

export function initBackground(): void {
  if (!api) return;
  if (api.onShellBackground) {
    api.onShellBackground((data: any) => applyBackground(data));
  }
  if (api.getShellBackground) {
    api.getShellBackground().then((r: any) => {
      if (r && r.success && r.background) applyBackground(r.background);
    }).catch(() => {});
  }
}
