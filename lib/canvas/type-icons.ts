"use client";

/** 节点类型的图标映射：卡片徽标 / 工具条 / 双击选择器 / 右键菜单共用一份 */
import {
  Clapperboard,
  Combine,
  Drama,
  Film,
  Image as ImageIcon,
  Layers,
  Music,
  ScrollText,
  StickyNote,
  Table,
  type LucideIcon,
} from "lucide-react";
import type { WingNodeType } from "./store";

export const TYPE_ICONS: Record<WingNodeType, LucideIcon> = {
  note: StickyNote,
  script: ScrollText,
  character: Drama,
  image: ImageIcon,
  video: Film,
  audio: Music,
  compose: Combine,
  storyboard: Clapperboard,
  shotlist: Table,
  group: Layers,
};
