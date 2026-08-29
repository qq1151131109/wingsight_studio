"use client";

/**
 * 提示词库（对标 open-storyboard-canvas 的 promptLibrary）：内置影视域预设 +
 * 用户收藏（localStorage 持久化）。点选即追加进生成输入面板。
 */

const FAV_KEY = "wingsight:prompt-favs";

export interface PromptPreset {
  group: string;
  text: string;
}

export const PROMPT_PRESETS: PromptPreset[] = [
  { group: "光影", text: "伦勃朗光，侧面高光与三角亮区，暗部细节保留" },
  { group: "光影", text: "冷暖对比布光，青橙调，电影级光比" },
  { group: "光影", text: "柔和窗光，自然漫射，低对比氛围" },
  { group: "光影", text: "霓虹环境反射，湿地面倒影，夜色氛围" },
  { group: "光影", text: "雾气漫射体积光，丁达尔效应，远景层次分明" },
  { group: "质感", text: "柯达 500T 胶片颗粒，夜景色调青绿偏移" },
  { group: "质感", text: "ARRI Alexa 35 数字电影质感，肤色自然，高光柔和过渡" },
  { group: "质感", text: "宽银幕变形镜头，水平蓝色光斑，椭圆形焦外" },
  { group: "镜头", text: "手持摄影，轻微晃动，纪实临场感" },
  { group: "镜头", text: "浅景深特写，背景奶油虚化，焦点锁定人物眼神" },
  { group: "镜头", text: "大远景交代环境，人物渺小，空间纵深压迫感" },
  { group: "氛围", text: "雨夜城市天台，霓虹灯牌，蒸汽与湿气" },
  { group: "氛围", text: "清晨薄雾的老巷，斜射晨光，尘埃漂浮" },
  { group: "氛围", text: "废弃工厂内景，锈蚀金属，顶光破洞洒落" },
];

export function loadFavorites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function toggleFavorite(text: string): string[] {
  const favs = loadFavorites();
  const next = favs.includes(text)
    ? favs.filter((x) => x !== text)
    : [...favs, text].slice(-100);
  localStorage.setItem(FAV_KEY, JSON.stringify(next));
  return next;
}
