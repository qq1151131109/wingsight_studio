import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => {};

/** hydration 探测：SSR 快照 false、客户端 true。portal 宿主用它把挂载
 *  推迟到 hydration 之后——若在 hydration 渲染期就往 body 挂 portal，
 *  浏览器插件抢先注入的 DOM（aminer-ai-extension-root 事故）会被 React
 *  当成失配报 hydration warning。 */
export const useMounted = () =>
  useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
