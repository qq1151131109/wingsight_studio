"use client";

/** 图片节点操作共享逻辑（顶部工具条与右键菜单两入口同源） */

import { useCanvasStore } from "./store";

/** 切换自由缩放；切回锁定时按图片原始比例回弹（保宽调高，
 *  novanova freeResize 范式补上回弹半步）。 */
export function toggleFreeResize(nodeId: string): void {
  const st = useCanvasStore.getState();
  const nd = st.nodes.find((n) => n.id === nodeId);
  if (!nd) return;
  st.commitHistory();
  const wasFree = Boolean(nd.data.freeResize);
  st.updateNodeData(nodeId, { freeResize: !wasFree });
  if (wasFree && nd.data.imageUrl) {
    const url = nd.data.imageUrl;
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const st2 = useCanvasStore.getState();
      const cur = st2.nodes.find((n) => n.id === nodeId);
      if (!cur) return;
      const w =
        cur.measured?.width ?? cur.width ?? (Number(cur.style?.width) || 320);
      const h = Math.max(
        140,
        Math.round((w * img.naturalHeight) / img.naturalWidth),
      );
      const curH = cur.measured?.height ?? cur.height ?? 0;
      if (Math.abs(h - curH) < 2) return;
      st2.setNodes(
        st2.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, style: { ...n.style, width: w, height: h } }
            : n,
        ),
      );
    };
    img.src = url;
  }
}
