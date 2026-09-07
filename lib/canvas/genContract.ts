/**
 * 版式契约推断（单一事实源）：出图时按「目标卡语义 + 提示词关键词 + 参考形态」
 * 推断本次生成走哪个版式契约（flow LAYOUT_SPECS 的 type）——桥接层提交时
 * 用它，PromptBar 事前展示同一结果（P3：把黑箱决策亮成可见可改的控件）。
 * 用户显式选择（PromptBar 版式 chip / 聊天工具 type 字段）永远最优先。
 *
 * 「报纸道具图出成电影剧照」事故（2026-09-07 宝马山项目）：关键词只认
 * 场景|空镜|环境，其余一律 shot——用户说「道具图」也被拍成剧照版式。
 * 现在道具/设定图类关键词落 prop，且推断结果事前可见、可手动覆盖。
 */
import { ASSET_TYPES } from "./shotRefs";

export type SheetAssetType = "character" | "scene" | "prop" | "costume" | "shot";

/** 说人话的版式名（PromptBar chip / 弹窗展示用） */
export const SHEET_LABELS: Record<SheetAssetType, string> = {
  character: "定妆照",
  scene: "空镜场景",
  prop: "道具结构图",
  costume: "服装结构图",
  shot: "电影剧照",
};

export const SHEET_TOOLTIPS: Record<SheetAssetType, string> = {
  character: "四格定妆照：胸像特写 + 三视图，角色一致性锚点",
  scene: "无人空镜：空间基准图，不出现人物与剧情行为",
  prop: "浅灰背景结构图：单件物件的多视图，不带人物场景",
  costume: "服装结构图：人台/平铺三视图 + 材质细节",
  shot: "电影剧照：人物在场景中的剧情画面，参考图锁脸",
};

/** 道具/设定图类关键词：命中落 prop（道具结构图版式） */
const PROP_KEYWORDS = /(道具|设定图|结构图|海报|报纸|文件|告示|信件|传单|标牌|图鉴)/;
/** 场景类关键词：命中落 scene（无人空镜） */
const SCENE_KEYWORDS = /(场景|空镜|环境)/;

export function inferAssetType(input: {
  /** 目标卡 nodeType（资产卡本尊走自身类型） */
  nodeType: string;
  /** 标题 + 提示词（关键词检测语料） */
  prompt: string;
  fromShotlist: boolean;
  isLook: boolean;
  /** Look 卡的父资产类型（isLook=true 时生效） */
  parentType: string;
  hasReferences: boolean;
  editMode: boolean;
}): SheetAssetType {
  const t = String(input.nodeType);
  const targetAssetType = (
    ASSET_TYPES as readonly string[]
  ).includes(t)
    ? (t as SheetAssetType)
    : undefined;
  if (targetAssetType) return targetAssetType;
  if (input.fromShotlist) return "shot";
  if (input.isLook) {
    if (input.parentType === "character") return "character";
    if (input.parentType === "scene") return "scene";
    return "prop";
  }
  if (input.editMode) return "shot";
  // 关键词分流（纯文生/参考生成语义不明时）：道具/设定图类词 → prop 结构
  // 图契约；场景词 → scene 空镜；否则 shot（本工具默认产出即剧照）
  if (!input.hasReferences) {
    if (PROP_KEYWORDS.test(input.prompt)) return "prop";
    if (SCENE_KEYWORDS.test(input.prompt)) return "scene";
  } else if (PROP_KEYWORDS.test(input.prompt)) {
    // 带参考也认道具词：参考此时是「形制锁定」（如按照片出报纸结构图），
    // 不该被 shot 版式拉成剧照
    return "prop";
  }
  return "shot";
}
