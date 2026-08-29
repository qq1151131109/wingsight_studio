"use client";

/**
 * 导演台的摄影语汇与提示词编译（对标 open-ai-canvas 的 director-prompt-compiler
 * 与 open-storyboard-canvas 的 cameraPromptLibrary）：
 *  - 景别/运镜/光圈是本地常量；机身/镜头/布光语汇从 agent 的 camera.py 拉取
 *    （单一事实源，离线时对应区块隐藏）
 *  - compileCinePrompt 把结构化选择编译成中文摄影语言，写进卡片 body 的
 *    【摄影】段（替换式，可反复编辑不堆积）
 */

import { apiFetch } from "@/lib/auth";

export const SHOT_SIZES = [
  "大远景",
  "远景",
  "全景",
  "中景",
  "近景",
  "特写",
] as const;

export interface CameraMove {
  id: string;
  /** 分镜卡 cameraMove 字段的短标签 */
  label: string;
  /** 编译进提示词的动作描述 */
  prompt: string;
}

export const CAMERA_MOVES: CameraMove[] = [
  { id: "static", label: "固定", prompt: "固定机位" },
  { id: "push", label: "推", prompt: "镜头缓慢推进" },
  { id: "pull", label: "拉", prompt: "镜头缓慢拉远" },
  { id: "panL", label: "左摇", prompt: "镜头向左横摇" },
  { id: "panR", label: "右摇", prompt: "镜头向右横摇" },
  { id: "tiltU", label: "上仰", prompt: "镜头向上摇摄" },
  { id: "tiltD", label: "下俯", prompt: "镜头向下摇摄" },
  { id: "orbit", label: "环绕", prompt: "镜头环绕主体运动" },
  { id: "handheld", label: "手持", prompt: "克制的手持摄影运动" },
  { id: "crane", label: "升降", prompt: "镜头垂直升降（摇臂感）" },
];

export const APERTURES = ["f/1.4", "f/2", "f/2.8", "f/4", "f/5.6", "f/8"] as const;

const APERTURE_DESC: Record<string, string> = {
  "f/1.4": "极浅景深，奶油般虚化，主体如梦般分离",
  "f/2": "浅景深，顺滑电影感焦外",
  "f/2.8": "较浅景深，柔和背景衬托主体",
  "f/4": "适中景深，轻微背景虚化",
  "f/5.6": "平衡景深，背景保留环境信息",
  "f/8": "大景深，环境与主体同样清晰，纪实感",
};

export interface CameraVocab {
  cameras: { id: string; look: string; lenses: string[] }[];
  lensHints: Record<string, string>;
  lightHints: string[];
}

const EMPTY_VOCAB: CameraVocab = {
  cameras: [],
  lensHints: {},
  lightHints: [],
};

let vocabCache: CameraVocab | null = null;

/** 拉取摄影语汇（模块级缓存；失败返回空表，面板隐藏对应区块） */
export async function getCameraVocab(): Promise<CameraVocab> {
  if (vocabCache) return vocabCache;
  try {
    const r = await apiFetch("/agent-service/camera-vocab");
    if (!r.ok) return EMPTY_VOCAB;
    vocabCache = (await r.json()) as CameraVocab;
    return vocabCache;
  } catch {
    return EMPTY_VOCAB;
  }
}

export interface CineSelection {
  shotSize: string;
  moveId: string;
  duration: string;
  cameraId: string;
  focal: string;
  aperture: string;
  lights: string[];
}

/** 结构化选择 → 中文摄影语言（与 camera.py 语汇同源同风格） */
export function compileCinePrompt(
  sel: CineSelection,
  vocab: CameraVocab,
): string {
  const move =
    CAMERA_MOVES.find((m) => m.id === sel.moveId) ?? CAMERA_MOVES[0];
  const cam = vocab.cameras.find((c) => c.id === sel.cameraId);
  const parts: string[] = [];
  parts.push(
    `${sel.shotSize}，${move.prompt}，时长 ${sel.duration.replace(/s$|秒$/, "")} 秒`,
  );
  if (cam) parts.push(cam.look);
  if (sel.focal) {
    parts.push(vocab.lensHints[sel.focal] ?? `${sel.focal} 焦段`);
  }
  parts.push(`${sel.aperture}，${APERTURE_DESC[sel.aperture] ?? "适中景深"}`);
  if (sel.lights.length > 0) parts.push(`布光：${sel.lights.join("、")}`);
  parts.push("保持镜头轴线连续与真实摄影机透视");
  return parts.join("；") + "。";
}

/** body 的【摄影】段标记（应用时整段替换，避免反复编辑堆积） */
export const CINE_MARK = "【摄影】";

export function applyCineToBody(body: string, cine: string): string {
  const idx = body.indexOf(CINE_MARK);
  const base = (idx >= 0 ? body.slice(0, idx) : body).trimEnd();
  return `${base}\n\n${CINE_MARK}${cine}`.trim();
}
