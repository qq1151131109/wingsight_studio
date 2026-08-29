"use client";

/**
 * 主题规则（颜色与时间规则均移植自 juben theme-store，localStorage key 与
 * juben 一致——同一浏览器两个产品共享外观偏好）：
 *  - 三态 auto | light | dark；auto 按当地时间 20:00–次日 08:00 夜间
 *  - 手动选择是临时覆盖：只生效到下一个时间边界，到点自动回落 auto
 *  - 边界时刻定时器自动切换；storage / visibilitychange 多标签同步
 */

import { create } from "zustand";

export const THEME_STORAGE_KEY = "wingsight.appearance.theme.v1";
export const THEME_OVERRIDE_UNTIL_STORAGE_KEY =
  "wingsight.appearance.theme-override-until.v1";

export type ThemeMode = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const DARK_START_HOUR = 20;
const DARK_END_HOUR = 8;

interface ThemeState {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  /** 切到当前反色（juben 语义）：日间点一下进夜间、夜间点一下回日间；
   *  写入手动覆盖，到下个时间边界自动回落 auto */
  toggleTheme: () => void;
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "auto" || value === "light" || value === "dark";
}

export function readStoredThemeMode(now = new Date()): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!isThemeMode(stored) || stored === "auto") return "auto";

    const overrideUntil = Number(
      window.localStorage.getItem(THEME_OVERRIDE_UNTIL_STORAGE_KEY),
    );
    if (Number.isFinite(overrideUntil) && overrideUntil > now.getTime())
      return stored;

    // 手动覆盖过期：回落 auto 并清掉覆盖时间戳
    window.localStorage.setItem(THEME_STORAGE_KEY, "auto");
    window.localStorage.removeItem(THEME_OVERRIDE_UNTIL_STORAGE_KEY);
    return "auto";
  } catch {
    return "auto";
  }
}

/** 当前北京小时（0-23）——时间规则固定按东八区判定，不随访问设备的时区漂移 */
function beijingHour(now = new Date()): number {
  return Math.floor((now.getTime() / 3600000 + 8) % 24);
}

export function resolveTheme(mode: ThemeMode, now = new Date()): ResolvedTheme {
  if (mode !== "auto") return mode;
  const hour = beijingHour(now);
  return hour >= DARK_START_HOUR || hour < DARK_END_HOUR ? "dark" : "light";
}

/** 距下一个 auto 切换边界（北京 8:00 / 20:00）的毫秒数 */
export function millisecondsUntilNextThemeBoundary(now = new Date()): number {
  const hour = beijingHour(now);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  // 北京 08:00 = UTC 00:00，北京 20:00 = UTC 12:00（d+1 进位由 Date.UTC 处理）
  const today08 = Date.UTC(y, m, d, 0);
  const today20 = Date.UTC(y, m, d, 12);
  const tomorrow08 = Date.UTC(y, m, d + 1, 0);
  const target =
    hour < DARK_END_HOUR ? today08 : hour < DARK_START_HOUR ? today20 : tomorrow08;
  return Math.max(1, target - now.getTime());
}

function applyTheme(mode: ThemeMode, resolvedTheme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.dataset.themeMode = mode;
  root.dataset.theme = resolvedTheme;
}

function persistThemeMode(mode: ThemeMode, now = new Date()) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    if (mode === "auto") {
      window.localStorage.removeItem(THEME_OVERRIDE_UNTIL_STORAGE_KEY);
    } else {
      // 手动覆盖只保留到下一个边界时刻
      window.localStorage.setItem(
        THEME_OVERRIDE_UNTIL_STORAGE_KEY,
        String(now.getTime() + millisecondsUntilNextThemeBoundary(now)),
      );
    }
  } catch {
    // 存储不可用时仍保留本次会话内的选择
  }
}

const initialMode = typeof window === "undefined" ? "auto" : readStoredThemeMode();

export const useThemeStore = create<ThemeState>()((set, get) => ({
  mode: initialMode,
  resolvedTheme: resolveTheme(initialMode),
  toggleTheme: () => {
    // 语义按"看到的颜色"取反：夜间点一下回日间、日间点一下进夜间——
    // 无论 mode 处于 auto 还是某种覆盖，一次点击必达用户想要的那个
    const mode: ThemeMode = get().resolvedTheme === "dark" ? "light" : "dark";
    const resolvedTheme = resolveTheme(mode);
    persistThemeMode(mode, new Date());
    applyTheme(mode, resolvedTheme);
    set({ mode, resolvedTheme });
  },
}));

/** 启动全局同步：边界定时器 + 多标签 storage + 可见性恢复（全站调一次） */
export function startThemeSync(): () => void {
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (boundaryTimer) clearTimeout(boundaryTimer);
    const { mode } = useThemeStore.getState();
    const resolvedTheme = resolveTheme(mode);
    applyTheme(mode, resolvedTheme);
    useThemeStore.setState({ resolvedTheme });

    boundaryTimer = setTimeout(() => {
      const currentMode = useThemeStore.getState().mode;
      persistThemeMode("auto", new Date());
      if (currentMode === "auto") {
        schedule();
      } else {
        useThemeStore.setState({ mode: "auto" });
      }
    }, millisecondsUntilNextThemeBoundary(new Date()));
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== THEME_OVERRIDE_UNTIL_STORAGE_KEY)
      return;
    schedule();
  };
  const handleVisibility = () => {
    if (document.visibilityState !== "visible") return;
    schedule();
  };

  window.addEventListener("storage", handleStorage);
  document.addEventListener("visibilitychange", handleVisibility);
  schedule();

  return () => {
    if (boundaryTimer) clearTimeout(boundaryTimer);
    window.removeEventListener("storage", handleStorage);
    document.removeEventListener("visibilitychange", handleVisibility);
  };
}
