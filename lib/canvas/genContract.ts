/**
 * 版式契约（单一事实源）：flow LAYOUT_SPECS 的 type 值域 + 前端两侧共享的
 * 版式解析。2026-09-07 空镜事故定案（「树木/草坪/全景」纯风景修改被关键词
 * 推断成「电影剧照」，版式的「呈现描述中的人物」命令句把无人空镜拍出人；
 * 同日用户看过 8 家竞品：没有任何一家在自由出图路径上做关键词推断+模板
 * 注入——意图声明靠显式动作，自由路径是传话筒）：
 *   生效路径 = 用户显式点选（版式 chip）> 声明上下文（资产卡自身类型/
 *   分镜派生/Look 父类型——卡片类型是用户建卡时声明的意图，不算猜）>
 *   none 原话直传（不注入任何版式段，仅附画风与参考职责，novanova KEEP 范式）。
 *   关键词推断只活在展示层（chip 的「推荐」标记），点选才生效。
 */
import { ASSET_TYPES } from "./shotRefs";

export type SheetAssetType = "character" | "scene" | "prop" | "costume" | "shot";
/** 版式选择值：none = 不注入版式模板（用户提示词原样直传） */
export type SheetSelection = SheetAssetType | "none";

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

export const SHEET_NONE_LABEL = "原话直传";
export const SHEET_NONE_TOOLTIP =
  "不套任何版式模板：提示词原样发给模型（仅附画风与参考职责）——自由出图与改图的默认，想生成什么直接说";

export function sheetSelectionLabel(sel: SheetSelection): string {
  return sel === "none" ? SHEET_NONE_LABEL : SHEET_LABELS[sel];
}

/** 道具/设定图类关键词：命中推荐 prop（道具结构图版式） */
const PROP_KEYWORDS = /(道具|设定图|结构图|海报|报纸|文件|告示|信件|传单|标牌|图鉴)/;
/** 场景类关键词：命中推荐 scene（无人空镜） */
const SCENE_KEYWORDS = /(场景|空镜|环境)/;

/**
 * 声明上下文解析（生效路径唯一入口）：只认「卡片声明的事实」——资产卡
 * 自身类型、分镜表派生、Look 卡父类型。无声明返回 null，调用方落 none
 * 直传。关键词推断绝不进这里（空镜事故：关键词猜 shot 把无人风景拍出人）。
 */
export function declaredAssetType(input: {
  /** 目标卡 nodeType（资产卡本尊走自身类型） */
  nodeType: string;
  fromShotlist: boolean;
  isLook: boolean;
  /** Look 卡的父资产类型（isLook=true 时生效） */
  parentType: string;
}): SheetAssetType | null {
  const t = String(input.nodeType);
  if ((ASSET_TYPES as readonly string[]).includes(t)) return t as SheetAssetType;
  if (input.fromShotlist) return "shot";
  if (input.isLook) {
    if (input.parentType === "character") return "character";
    if (input.parentType === "scene") return "scene";
    return "prop";
  }
  return null;
}

/**
 * 推荐推断（仅展示层）：声明上下文 + 关键词启发，供版式 chip 的「推荐」
 * 标记。返回值不直接生效——错推荐无危害，用户点选才声明意图。
 */
export function recommendAssetType(input: {
  /** 标题 + 提示词（关键词检测语料） */
  prompt: string;
  hasReferences: boolean;
  editMode: boolean;
  declared: SheetAssetType | null;
}): SheetSelection {
  if (input.declared) return input.declared;
  // 改图（本卡原图锚点）推荐直传：EDIT 最小模板已承担指令语义，
  // 版式措辞只会帮倒忙（novanova edit=KEEP 范式）
  if (input.editMode) return "none";
  // 关键词启发（纯文生/参考生成语义不明时）：道具/设定图类词 → prop 结构
  // 图契约；场景词 → scene 空镜。带参考只认道具词——「带参考+场景词」
  // 通常是「按参考在场景里出剧照」，不推荐空镜
  if (PROP_KEYWORDS.test(input.prompt)) return "prop";
  if (!input.hasReferences && SCENE_KEYWORDS.test(input.prompt)) return "scene";
  return "none";
}
