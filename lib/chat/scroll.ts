"use client";

/**
 * 聊天滚动视口的两件共用工具（TurnLocator 与 ChatSearch 同源）：
 *  - findViewport：从消息列表向上爬到第一个真正带溢出的祖先（v2 的滚动容器
 *    是无类名 DIV，类名不稳定不能当选择器；高度超过视口 1.2 倍的是内容级
 *    包装而非滚动视口，流式重排帧里判据会瞬时翻脸匹配到它们，跳过继续爬）
 *  - escapeStickToBottom：逃离 v2 贴底锁（use-stick-to-bottom）——该库只认
 *    「wheel 向上」为用户解除贴底的意图（wheel 监听器同步翻转 isAtBottom），
 *    程序化 scrollIntoView / scrollTo 它不认，流式期间会逐帧把视图拽回底部，
 *    与跳转方向打架。跳转前在滚动容器上合成一次向上的 wheel 让库先解锁。
 */

export function findViewport(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
    if (
      i > 0 &&
      cur.scrollHeight > cur.clientHeight + 2 &&
      cur.clientHeight <= window.innerHeight * 1.2
    )
      return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return null;
}

export function escapeStickToBottom(vp: HTMLElement | null) {
  vp?.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }),
  );
}
