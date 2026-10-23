/**
 * 主进程主题管理器（权威单例）
 *
 * 主题是应用级全局状态，权威放主进程：
 *   - 持有唯一的 ThemeRuntime（纯逻辑，从 plugins/runtime 复用）
 *   - 变化时广播给所有窗口（壳页面改 --ck-* 变量；AI 页面同步）
 *   - 渲染进程的 ctx.theme 通过 IPC 代理到这里
 *
 * 与渲染进程那份的关系：
 *   - plugins/runtime/theme-runtime.ts 是平台无关纯逻辑，两处共用
 *   - 本文件是主进程权威实例；渲染进程不自己建注册表
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ThemeRuntime } from '../../plugins/runtime/theme-runtime.js';
import type { ThemeSnapshot, ThemeDefinition, ThemeTokenOverrides } from '../../plugins/runtime/theme-runtime.js';
import os from 'node:os';
import * as windowState from '../window.js';

const require = createRequire(import.meta.url);

let runtime: ThemeRuntime | null = null;

// ===== 偏好持久化（对齐 DSH：偏好存盘，退出不丢）=====
interface ThemeState { preference?: string }
function getStateFile(): string {
  return path.join(process.env.CUCKOO_HOME || path.join(os.homedir(), '.cuckoo'), 'theme-state.json');
}
function readPreference(): string | null {
  try {
    const file = getStateFile();
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return raw && typeof raw.preference === 'string' ? raw.preference : null;
  } catch { return null; }
}
function writePreference(preference: string): void {
  try {
    const file = getStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ preference }, null, 2), 'utf-8');
  } catch { /* ignore */ }
}
/** 订阅者：窗口 webContents，变化时推快照 */
const subscribers = new Set<any>();

// ===== 用户自定义颜色（持久化覆盖层，供主题类插件/UI 使用）=====
// 新版结构（多主题）：{ activeId: string, themes: [{ id, name, tokens, createdAt }] }
// 旧版兼容（单主题）：{ token: { light, dark } } —— 自动升级为单主题
const USER_THEME_SOURCE = 'user-custom';
function getUserThemeFile(): string {
  return path.join(process.env.CUCKOO_HOME || path.join(os.homedir(), '.cuckoo'), 'user-theme.json');
}

interface SavedThemeBackground {
  url: string;
  overlay: string;
}
interface SavedTheme {
  id: string;
  name: string;
  tokens: ThemeTokenOverrides;
  /** 主题关联的背景图（可选） */
  background?: SavedThemeBackground | null;
  createdAt: string;
}
interface ThemesFile {
  activeId: string | null;
  themes: SavedTheme[];
}

/** 生成短 id */
function genThemeId(): string {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 读多主题文件（兼容旧单主题格式，自动升级） */
function readThemesFile(): ThemesFile {
  const empty: ThemesFile = { activeId: null, themes: [] };
  try {
    const file = getUserThemeFile();
    if (!fs.existsSync(file)) return empty;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return empty;
    // 新格式
    if (Array.isArray((raw as any).themes)) {
      const rf = raw as ThemesFile;
      return {
        activeId: typeof rf.activeId === 'string' ? rf.activeId : null,
        themes: rf.themes.filter((t: any) => t && typeof t.id === 'string' && t.tokens && typeof t.tokens === 'object')
          .map((t: any) => ({ id: String(t.id), name: String(t.name || '未命名'), tokens: t.tokens, background: (t.background && typeof t.background === 'object' && typeof t.background.url === 'string') ? { url: String(t.background.url), overlay: String(t.background.overlay || 'rgba(10,12,20,0.5)') } : null, createdAt: String(t.createdAt || new Date().toISOString()) })),
      };
    }
    // 旧格式：{ token: {light,dark} } → 升级为单主题
    const keys = Object.keys(raw);
    if (keys.length && keys.every((k) => k.startsWith('--ck-'))) {
      const id = genThemeId();
      const t: SavedTheme = { id, name: '默认主题', tokens: raw as ThemeTokenOverrides, createdAt: new Date().toISOString() };
      const upgraded: ThemesFile = { activeId: id, themes: [t] };
      // 写回新格式
      try { fs.writeFileSync(file, JSON.stringify(upgraded, null, 2), 'utf-8'); } catch (_) { /* ignore */ }
      return upgraded;
    }
    return empty;
  } catch { return empty; }
}

function writeThemesFile(v: ThemesFile): boolean {
  try {
    const file = getUserThemeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

/** 旧 API 兼容：返回当前激活主题的 tokens（无激活则 {}） */
function readUserTheme(): ThemeTokenOverrides | null {
  const f = readThemesFile();
  const act = f.themes.find((t) => t.id === f.activeId);
  return act ? act.tokens : null;
}
function applyUserTheme(tokens: ThemeTokenOverrides | null): void {
  const t = getTheme();
  try { t.overrideTokens(USER_THEME_SOURCE, tokens && Object.keys(tokens).length ? tokens : {}); } catch { /* ignore */ }
}
function getUserTheme(): ThemeTokenOverrides {
  return readUserTheme() || {};
}
/** 兼容旧 API：写入当前激活主题（无激活则新建"默认主题"） */
function setUserTheme(tokens: ThemeTokenOverrides): boolean {
  const f = readThemesFile();
  let act = f.themes.find((t) => t.id === f.activeId);
  if (!act) {
    act = { id: genThemeId(), name: '默认主题', tokens: tokens || {}, createdAt: new Date().toISOString() };
    f.themes.push(act);
    f.activeId = act.id;
  } else {
    act.tokens = tokens || {};
  }
  const ok = writeThemesFile(f);
  if (ok) applyUserTheme(act.tokens);
  return ok;
}
/** 兼容旧 API：清空所有主题 */
function resetUserTheme(): boolean {
  try {
    const file = getUserThemeFile();
    if (fs.existsSync(file)) fs.rmSync(file);
  } catch { /* ignore */ }
  applyUserTheme(null);
  return true;
}

// ===== 多主题 CRUD =====
function listUserThemes(): ThemesFile {
  return readThemesFile();
}

/** 新建主题（返回新 id） */
function createUserTheme(name: string, tokens: ThemeTokenOverrides, background?: SavedThemeBackground | null): { id?: string; error?: string } {
  const n = String(name || '').trim();
  if (!n) return { error: '主题名不能为空' };
  const f = readThemesFile();
  if (f.themes.some((t) => t.name === n)) return { error: '已存在同名主题：' + n };
  const id = genThemeId();
  const bg = (background && typeof background.url === 'string' && background.url)
    ? { url: String(background.url), overlay: String(background.overlay || 'rgba(10,12,20,0.5)') }
    : null;
  f.themes.push({ id, name: n, tokens: tokens || {}, background: bg, createdAt: new Date().toISOString() });
  if (!writeThemesFile(f)) return { error: '写入失败' };
  return { id };
}

/** 更新主题（name / tokens / background） */
function updateUserTheme(id: string, patch: { name?: string; tokens?: ThemeTokenOverrides; background?: SavedThemeBackground | null }): { success: boolean; error?: string } {
  const f = readThemesFile();
  const t = f.themes.find((x) => x.id === id);
  if (!t) return { success: false, error: '主题不存在: ' + id };
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) return { success: false, error: '主题名不能为空' };
    if (f.themes.some((x) => x.id !== id && x.name === n)) return { success: false, error: '已存在同名主题：' + n };
    t.name = n;
  }
  if (patch.tokens !== undefined) t.tokens = patch.tokens;
  if (patch.background !== undefined) {
    t.background = (patch.background && typeof patch.background.url === 'string' && patch.background.url)
      ? { url: String(patch.background.url), overlay: String(patch.background.overlay || 'rgba(10,12,20,0.5)') }
      : null;
  }
  if (!writeThemesFile(f)) return { success: false, error: '写入失败' };
  // 如果更新的是当前激活的，立即应用
  if (f.activeId === id) applyUserTheme(t.tokens);
  return { success: true };
}

/** 删除主题 */
function deleteUserTheme(id: string): { success: boolean; error?: string } {
  const f = readThemesFile();
  const idx = f.themes.findIndex((x) => x.id === id);
  if (idx < 0) return { success: false, error: '主题不存在' };
  // 默认主题不能删除（保留一个兜底主题）
  if (f.themes[idx].name === '默认主题') return { success: false, error: '默认主题不能删除' };
  f.themes.splice(idx, 1);
  if (f.activeId === id) {
    f.activeId = f.themes.length ? f.themes[0].id : null;
  }
  if (!writeThemesFile(f)) return { success: false, error: '写入失败' };
  // 应用新的激活主题（或清空）
  const act = f.themes.find((x) => x.id === f.activeId);
  applyUserTheme(act ? act.tokens : null);
  return { success: true };
}

/** 取当前激活主题的 background（无则 null） */
function getActiveBackground(): SavedThemeBackground | null {
  const f = readThemesFile();
  const act = f.themes.find((t) => t.id === f.activeId);
  return (act && act.background) || null;
}

/** 切换激活主题（返回该主题的 background，供调用方应用） */
function activateUserTheme(id: string): { success: boolean; error?: string; background?: SavedThemeBackground | null; tokens?: ThemeTokenOverrides } {
  const f = readThemesFile();
  const t = f.themes.find((x) => x.id === id);
  if (!t) return { success: false, error: '主题不存在' };
  f.activeId = id;
  if (!writeThemesFile(f)) return { success: false, error: '写入失败' };
  applyUserTheme(t.tokens);
  return { success: true, background: t.background || null, tokens: t.tokens };
}

/** 取（或懒创建）主进程主题权威实例 */
function getTheme(): ThemeRuntime {
  if (runtime) return runtime;
  const bus = {
    on() { return () => {}; },
    once() { return () => {}; },
    off() {},
    emit(event: string, ...args: any[]) {
      if (event === 'theme/change') broadcastSnapshot(args[0] as ThemeSnapshot);
    },
    async parallel() { return []; },
    async serial() { return undefined; },
    bail() { return undefined; },
    async waterfall(v: any) { return v; },
    clear() {},
  };
  // 系统配色提供者：主进程 nativeTheme（主进程无 matchMedia）
  const sysProvider = (): 'light' | 'dark' => {
    try {
      const nt = require('electron').nativeTheme;
      return nt && nt.shouldUseDarkColors ? 'dark' : 'light';
    } catch { return 'light'; }
  };
  runtime = new ThemeRuntime(bus as any, sysProvider);
  // 系统配色变化时（偏好为 system）重新发布
  try {
    const nt = require('electron').nativeTheme;
    if (nt && typeof nt.on === 'function') {
      nt.on('updated', () => {
        try { if (runtime && runtime.getTheme().preference === 'system') (runtime as any).publish(); } catch (_) {}
      });
    }
  } catch (_) { /* ignore */ }
  // 读回上次保存的偏好（若合法）
  const saved = readPreference();
  if (saved) {
    try { runtime.setTheme(saved); } catch { /* 未注册的旧主题，忽略 */ }
  }
  // 应用用户自定义颜色覆盖层
  try { applyUserTheme(readUserTheme()); } catch { /* ignore */ }
  return runtime;
}

/** 当前快照 */
function snapshot(): ThemeSnapshot {
  return getTheme().getTheme();
}

/** 把一个 webContents 加入订阅（返回退订函数） */
function subscribe(webContents: any): () => void {
  subscribers.add(webContents);
  return () => { subscribers.delete(webContents); };
}

/** 同步原生主题（AI 网页按 prefers-color-scheme 跟随；不注入网页）*/
function syncNativeTheme(snap: ThemeSnapshot): void {
  try {
    const electron = require('electron');
    const nativeTheme = electron && electron.nativeTheme;
    if (!nativeTheme) return;
    // 偏好为 system → 让原生跟随系统；否则用激活主题的 colorScheme
    if (snap.preference === 'system') nativeTheme.themeSource = 'system';
    else nativeTheme.themeSource = snap.active && snap.active.colorScheme === 'dark' ? 'dark' : 'light';
  } catch (_) { /* ignore */ }
}

/** 变化时推送快照给所有订阅者 + 所有窗口 */
function broadcastSnapshot(snap: ThemeSnapshot): void {
  syncNativeTheme(snap);
  // 订阅者（显式订阅的 webContents）
  for (const wc of subscribers) {
    try { wc.send('theme-changed', snap); } catch (_) { /* ignore */ }
  }
  // 所有窗口的壳页面 + AI 页面 + Harness 视图都推一份（保证一致）
  try {
    for (const ctx of windowState.getAllContexts()) {
      try { ctx.win && ctx.win.webContents && ctx.win.webContents.send('theme-changed', snap); } catch (_) {}
      try { ctx.view && ctx.view.webContents && ctx.view.webContents.send('theme-changed', snap); } catch (_) {}
      try { (ctx as any).harnessView && (ctx as any).harnessView.webContents && !(ctx as any).harnessView.webContents.isDestroyed() && (ctx as any).harnessView.webContents.send('theme-changed', snap); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
}

// ===== 供 IPC 调用的操作 =====
function setTheme(id: string): ThemeSnapshot {
  getTheme().setTheme(id);
  writePreference(id);
  return snapshot();
}
function register(definition: ThemeDefinition): string {
  const dispose = getTheme().register(definition);
  // 注册表以主进程为权威；这里返回一个 token，IPC 侧据此撤销
  return storeDisposer(dispose);
}
function overrideTokens(source: string, tokens: ThemeTokenOverrides): string {
  const dispose = getTheme().overrideTokens(source, tokens);
  return storeDisposer(dispose);
}
function list(): readonly ThemeDefinition[] {
  return getTheme().list();
}

// disposer 仓库：IPC 不能传函数，用字符串 token 映射
const disposers = new Map<string, () => void>();
let disposerSeq = 0;
function storeDisposer(fn: () => void): string {
  const id = 'd' + (disposerSeq++);
  disposers.set(id, fn);
  return id;
}
function dispose(token: string): boolean {
  const fn = disposers.get(token);
  if (!fn) return false;
  disposers.delete(token);
  try { fn(); } catch (_) { /* ignore */ }
  return true;
}

export {
  getTheme, snapshot, subscribe, broadcastSnapshot,
  setTheme, register, overrideTokens, list, dispose,
  getUserTheme, setUserTheme, resetUserTheme,
  listUserThemes, createUserTheme, updateUserTheme, deleteUserTheme, activateUserTheme, getActiveBackground,
};
