"use client";

/**
 * 图标笔画档位（better-ui「Match icon stroke to text weight」）：
 * lucide 出厂笔画是 2（配 500–600 字重刚好），但本产品大量工具栏/侧栏标签是
 * regular 400——2px 的图标压在 400 的 12px 文字旁边，图标显得比文字重一档，
 * 整排控件读起来"发闷"。
 *
 * 规则（24px 网格）：regular 用 1.5，medium/semibold 用 2。
 * 全局基线在 app/layout.tsx 设 1.5；声明 medium 的按钮/标题局部包回 2。
 *
 * absoluteStrokeWidth 必须开：lucide 的 strokeWidth 是 24px 网格值，小尺寸图标
 * 会按比例缩细（14px 图标 2 档实际只画 1.17px），绝对笔画数才是稳定的光学重量。
 */

import { type ReactNode } from "react";
import { LucideProvider } from "lucide-react";

/** 常规（400）文字旁的图标：1.5px 绝对笔画 */
export default function IconWeight({ children }: { children: ReactNode }) {
  return (
    <LucideProvider strokeWidth={1.5} absoluteStrokeWidth>
      {children}
    </LucideProvider>
  );
}

/** 中/半粗（500–600）文字旁的图标：2px 绝对笔画（局部把全局基线包回来） */
export function IconWeightMedium({ children }: { children: ReactNode }) {
  return (
    <LucideProvider strokeWidth={2} absoluteStrokeWidth>
      {children}
    </LucideProvider>
  );
}
