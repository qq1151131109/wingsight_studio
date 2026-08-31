/** Popover 外点关闭：open 时捕获阶段监听 pointerdown，点击落在 ref 外即关。
 *  捕获阶段先于画布/输入条自身的 stopPropagation，任何空白点击都能收到；
 *  onClose 走 latest-ref，调用方可直接传内联箭头（不重挂监听） */
import { useEffect, useRef, type RefObject } from "react";

export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  const cb = useRef(onClose);
  // eslint-disable-next-line react-hooks/refs -- latest-ref 刻意模式：回调换新不重挂监听（nodes.tsx genRef 同款先例）
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (
        ref.current &&
        e.target instanceof Node &&
        !ref.current.contains(e.target)
      )
        cb.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [ref, open]);
}
