"use client";

/**
 * 提示词库：内置影视域预设（硬编码清单）+ 用户级「我的提示词」（服务端
 * /api/v1/prompt-presets，按账号隔离，添加/编辑/删除）。原 localStorage
 * 收藏（wingsight:prompt-favs）由 migrateLegacyFavorites 一次性迁入服务端。
 * 点选即追加进生成输入面板（PROMPT_PICK_EVENT）。
 */

import { apiFetch } from "@/lib/auth";

const LEGACY_FAV_KEY = "wingsight:prompt-favs";

export interface PromptPreset {
  group: string;
  text: string;
}

/** 内置影视域预设（只读；星标 = 存一份进「我的」，可再编辑） */
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

// ---------- 我的提示词（服务端，/api/v1 前缀） ----------

export interface MyPrompt {
  id: string;
  /** 分组（可空；内置条目迁入时带原分组） */
  group: string;
  text: string;
}

export async function listMyPrompts(): Promise<MyPrompt[]> {
  const r = await apiFetch("/api/v1/prompt-presets");
  if (!r.ok) throw new Error(`提示词库加载失败（${r.status}）`);
  const data = (await r.json()) as { presets?: MyPrompt[] };
  return data.presets ?? [];
}

export async function createMyPrompt(group: string, text: string): Promise<MyPrompt> {
  const r = await apiFetch("/api/v1/prompt-presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group, text }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160) || `保存失败（${r.status}）`);
  const data = (await r.json()) as { preset: MyPrompt };
  return data.preset;
}

export async function updateMyPrompt(
  id: string,
  opts: { group?: string; text?: string },
): Promise<MyPrompt> {
  const r = await apiFetch(`/api/v1/prompt-presets/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160) || `保存失败（${r.status}）`);
  const data = (await r.json()) as { preset: MyPrompt };
  return data.preset;
}

export async function deleteMyPrompt(id: string): Promise<void> {
  const r = await apiFetch(`/api/v1/prompt-presets/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`删除失败（${r.status}）`);
}

/** 旧版 localStorage 收藏一次性迁入服务端：逐条建为「我的提示词」（跳过
 *  已存在同文条目），全部成功才清掉本地键——失败保留，下次打开重试。 */
export async function migrateLegacyFavorites(): Promise<MyPrompt[]> {
  let texts: string[];
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_FAV_KEY) ?? "[]");
    texts = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    localStorage.removeItem(LEGACY_FAV_KEY);
    return [];
  }
  if (texts.length === 0) {
    localStorage.removeItem(LEGACY_FAV_KEY);
    return [];
  }
  const existing = new Set((await listMyPrompts()).map((p) => p.text));
  for (const t of texts) {
    if (!t.trim() || existing.has(t)) continue;
    await createMyPrompt("", t);
  }
  localStorage.removeItem(LEGACY_FAV_KEY);
  return listMyPrompts();
}
