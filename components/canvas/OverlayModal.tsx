"use client";

/**
 * 全屏弹窗外壳：portal 到 body 渲染。画布树里不能放全屏浮层——
 * `.react-flow` 根容器自带 z-index:0 的层叠上下文（内部 z 再高也压不过
 * fixed 的聊天侧栏 z-1200），卡片内弹窗还会被 viewport transform
 * 劫持 fixed 定位（定位与缩放失真）。经此挂 body 可同时逃开两者。
 * 全站 z 档位表见 globals.css「z 序档位表」（模态入 1300 档）。
 * props 透传给背板 div（onClick / onMouseMove / ref 等），关闭与交互
 * 语义由调用方决定。
 */
import { createPortal } from "react-dom";

export default function OverlayModal({
  ref,
  children,
  ...rest
}: React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLDivElement>,
  HTMLDivElement
>) {
  return createPortal(
    <div ref={ref} {...rest}>
      {children}
    </div>,
    document.body,
  );
}
