"use client";

/**
 * 图标笔画档位（better-ui「Match icon stroke to text weight」）：
 * lucide 出厂笔画是 2（配 500–600 字重刚好），但本产品大量工具栏/侧栏标签是
 * regular 400——2 档的图标压在 400 的 12px 文字旁边，图标显得比文字重一档，
 * 整排控件读起来"发闷"。
 *
 * 规则（24px 网格属性值）：regular 用 1.5，medium/semibold 用 2，加粗/独立强调 2.5。
 * 全局基线在 app/layout.tsx 设 1.5；声明 medium 的按钮/标题局部包回 2。
 *
 * **取值口径**：这里的 1.5 / 2 是 SVG 在 24 网格上的属性值，不是屏幕上渲染的
 * 像素数——规范表头写的「(24px grid)」就是这个意思（其示例 `stroke-width="2"`
 * 配 `class="size-4"` 也印证）。本项目图标尺寸一律走 CSS 类，属性值随
 * 渲染尺寸等比缩放：14px 图标上 1.5 档渲染约 0.88px。这是图标集的固有行为，
 * 不是缺陷，别按「渲染成 1.5 物理像素」去调它。
 *
 * 曾开过 lucide 的 absoluteStrokeWidth，但它是空转的：lucide 用它做
 * `strokeWidth × 24 / size` 换算，而 size prop 缺省即 24、全站无人传 size，
 * 因子恒为 1。已摘掉，免后来人以为尺寸换算已被处理。
 */

import { type ReactNode } from "react";
import { LucideProvider } from "lucide-react";

/** 常规（400）文字旁的图标：24 网格 1.5 档 */
export default function IconWeight({ children }: { children: ReactNode }) {
  return <LucideProvider strokeWidth={1.5}>{children}</LucideProvider>;
}

/** 中/半粗（500–600）文字旁的图标：24 网格 2 档（局部把全局基线包回来） */
export function IconWeightMedium({ children }: { children: ReactNode }) {
  return <LucideProvider strokeWidth={2}>{children}</LucideProvider>;
}
