/**
 * IPC：主题（主进程权威 ↔ 渲染进程）
 *
 * 端点：
 *   theme-get        取当前快照
 *   theme-set        切换偏好（light/dark/system 或已注册主题 id）
 *   theme-list       列出已注册主题
 *   theme-register   注册主题（返回 disposer token）
 *   theme-override   叠加覆盖层（返回 disposer token）
 *   theme-dispose    撤销某次注册/覆盖（按 token）
 *   theme-subscribe  订阅变化（变化时推 'theme-changed'）
 */
import { createRequire } from 'node:module';
import * as themeManager from '../theme/theme-manager.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

function registerThemeIpc(): void {
  ipcMain.handle('theme-get', () => {
    return { success: true, snapshot: themeManager.snapshot() };
  });

  ipcMain.handle('theme-set', (_e: any, { id }: any = {}) => {
    try {
      const snap = themeManager.setTheme(id);
      return { success: true, snapshot: snap };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-list', () => {
    return { success: true, themes: themeManager.list() };
  });

  ipcMain.handle('theme-register', (_e: any, { definition }: any = {}) => {
    try {
      const token = themeManager.register(definition);
      return { success: true, token };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-override', (_e: any, { source, tokens }: any = {}) => {
    try {
      const token = themeManager.overrideTokens(source, tokens);
      return { success: true, token };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-dispose', (_e: any, { token }: any = {}) => {
    return { success: themeManager.dispose(token) };
  });

  ipcMain.handle('theme-user-get', () => {
    return { success: true, tokens: themeManager.getUserTheme() };
  });

  ipcMain.handle('theme-user-set', (_e: any, { tokens }: any = {}) => {
    try {
      const ok = themeManager.setUserTheme(tokens || {});
      return { success: ok, snapshot: themeManager.snapshot() };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-user-reset', () => {
    try {
      themeManager.resetUserTheme();
      return { success: true, snapshot: themeManager.snapshot() };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // ===== 多主题 CRUD =====
  ipcMain.handle('theme-user-list', () => {
    return { success: true, data: themeManager.listUserThemes() };
  });

  ipcMain.handle('theme-user-create', (_e: any, { name, tokens, background }: any = {}) => {
    try {
      const r = themeManager.createUserTheme(name, tokens || {}, background);
      if (r.error) return { success: false, error: r.error };
      return { success: true, id: r.id, snapshot: themeManager.snapshot() };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-user-update', (_e: any, { id, name, tokens, background }: any = {}) => {
    try {
      const patch: any = { name, tokens };
      if (background !== undefined) patch.background = background;
      const r = themeManager.updateUserTheme(id, patch);
      if (!r.success) return r;
      return { success: true, snapshot: themeManager.snapshot() };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-user-delete', (_e: any, { id }: any = {}) => {
    try {
      const r = themeManager.deleteUserTheme(id);
      if (!r.success) return r;
      return { success: true, snapshot: themeManager.snapshot() };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-user-activate', (_e: any, { id }: any = {}) => {
    try {
      const r = themeManager.activateUserTheme(id);
      if (!r.success) return r;
      // 自动同步背景到壳页面 + Harness（不写文件，主题的 background 存在 user-theme.json 里）
      // 注意：必须用 require 而非 import()——CJS 下 import() 是 ESM 动态导入，与 require 不共享模块缓存，
      // 会导致 plugin.js 被加载两份，shellBackground 变量不同步（背景推 null 的 bug）。
      try {
        const bg = r.background || null;
        const m: any = require('./plugin.js');
        if (m && typeof m.applyShellBackground === 'function') {
          m.applyShellBackground(bg ? { url: bg.url, overlay: bg.overlay } : null, false);
        }
      } catch (_) { /* ignore */ }
      return { success: true, snapshot: themeManager.snapshot(), background: r.background || null };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('theme-subscribe', (event: any) => {
    const wc = event && event.sender;
    if (!wc) return { success: false, error: 'no sender' };
    const off = themeManager.subscribe(wc);
    // 立刻推一次当前快照
    try { wc.send('theme-changed', themeManager.snapshot()); } catch (_) { /* ignore */ }
    // 无法在 IPC 里持有 off 到渲染进程销毁；用 once('destroyed') 清理
    try { wc.once('destroyed', () => off()); } catch (_) { /* ignore */ }
    return { success: true };
  });
}

export { registerThemeIpc };
