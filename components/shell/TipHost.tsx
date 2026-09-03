"use client";

/**
 * 全局悬停提示（data-tip 事件委托）：整站只需在根布局挂一次本组件，
 * 任意元素加 data-tip 属性即得提示，无需逐个接线。
 * 单个 fixed 气泡 portal 到 body——不受滚动容器 overflow 裁剪；
 * 位置先按预估高度落点，渲染后实测气泡高度做二次修正：
 * 上方压进顶栏安全区（SAFE_TOP，遮挡实测来自不透明 h-11 顶栏）则翻到下方，
 * 下方出屏则翻回/夹紧；横向按最大半宽夹紧不出屏。滚动/按下即隐藏。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMounted } from "@/lib/use-mounted";

type Tip = {
  text: string;
  x: number; // 源元素中心（横向夹紧基准）
  yTop: number; // 源元素上缘（视口坐标）
  yBottom: number; // 源元素下缘
  below: boolean; // 当前朝向
  top: number; // 气泡顶边落点
};

const DELAY_MS = 350;
const GAP = 8;
// 顶栏（h-11 标题条）+ 余量：气泡不许压进这片不透明区域
const SAFE_TOP = 60;
// 首帧落点的预估气泡高（渲染后按实测二次修正）
const EST_H = 28;
// 气泡 max-width 280 的一半：横向夹紧用（比真实半宽保守，窄气泡更安全）
const HALF_MAX = 144;

export default function TipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const mounted = useMounted();
  const timer = useRef<number | undefined>(undefined);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  // 当前悬停元素：定时器到期时复核，防陈旧气泡
  const cur = useRef<Element | null>(null);

  useEffect(() => {
    const show = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      const r = el.getBoundingClientRect();
      // display:none（如折叠组子卡）等不可见元素不提示
      if (r.width === 0 && r.height === 0) return;
      const vh = window.innerHeight;
      // 上方放不下（含顶栏安全区）且下方放得下才先朝下，否则默认朝上等二次修正
      const below =
        r.top - GAP - EST_H < SAFE_TOP && r.bottom + GAP + EST_H <= vh - 4;
      setTip({
        text,
        x: r.left + r.width / 2,
        yTop: r.top,
        yBottom: r.bottom,
        below,
        top: below ? r.bottom + GAP : Math.max(r.top - GAP - EST_H, SAFE_TOP),
      });
    };
    const onOver = (e: MouseEvent) => {
      const el =
        (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === cur.current) return;
      window.clearTimeout(timer.current);
      cur.current = el;
      if (!el) {
        setTip(null);
        return;
      }
      timer.current = window.setTimeout(() => {
        if (cur.current === el) show(el);
      }, DELAY_MS);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el =
        (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      window.clearTimeout(timer.current);
      cur.current = el;
      if (el && el.matches(":focus-visible")) show(el);
      else setTip(null);
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      cur.current = null;
      setTip(null);
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    // 捕获阶段接住内部滚动容器：气泡是 fixed 的，滚动会让它脱离源元素
    document.addEventListener("scroll", hide, true);
    document.addEventListener("pointerdown", hide);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("pointerdown", hide);
    };
  }, []);

  // 二次修正：实测气泡高度后，朝上但顶边越入顶栏安全区 → 翻下方（放得下时），
  // 朝下但底部出屏 → 翻回上方/贴底夹紧
  useLayoutEffect(() => {
    if (!tip || !bubbleRef.current) return;
    const h = bubbleRef.current.offsetHeight;
    const vh = window.innerHeight;
    const aboveTop = tip.yTop - GAP - h;
    const belowTop = tip.yBottom + GAP;
    let below = tip.below;
    let top = below ? belowTop : aboveTop;
    if (!below && aboveTop < SAFE_TOP) {
      if (belowTop + h <= vh - 4) {
        below = true;
        top = belowTop;
      } else {
        top = SAFE_TOP; // 上下都放不下：钉在安全线（极端场景，宁压按钮不进顶栏）
      }
    } else if (below && belowTop + h > vh - 4) {
      if (aboveTop >= SAFE_TOP) {
        below = false;
        top = aboveTop;
      } else {
        top = vh - 4 - h;
      }
    }
    if (below !== tip.below || top !== tip.top) setTip({ ...tip, below, top });
  }, [tip]);

  if (!mounted || !tip) return null;
  return createPortal(
    <div
      ref={bubbleRef}
      className="ws-tip-bubble"
      style={{
        left: Math.min(
          Math.max(tip.x, HALF_MAX),
          window.innerWidth - HALF_MAX,
        ),
        top: tip.top,
        transform: "translateX(-50%)",
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
