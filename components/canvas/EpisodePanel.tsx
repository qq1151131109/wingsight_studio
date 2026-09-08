"use client";

/** 分集面板（底坞「分集」）：一张剧本卡 = 一集。
 *  按集号列出每集与它的产物统计，点击聚焦（运镜 + 压暗其余卡），↑↓ 重排集号。
 *  集一多，画布上「这一集有哪些东西」肉眼分不出来——这个面板就是集目录。 */

import { useEffect, useMemo } from "react";
import { ArrowDown, ArrowUp, Clapperboard, X } from "lucide-react";
import {
  episodeList,
  episodeNoOf,
  episodeStatsLine,
  nodesOfEpisode,
  useCanvasStore,
} from "@/lib/canvas/store";
import { FOCUS_NODES_EVENT } from "@/lib/canvas/events";

export default function EpisodePanel({
  focusId,
  onFocus,
  onClose,
}: {
  /** 当前聚焦的集（null = 未聚焦） */
  focusId: string | null;
  onFocus: (id: string | null) => void;
  onClose: () => void;
}) {
  const nodes = useCanvasStore((s) => s.nodes);
  const episodes = useMemo(() => episodeList(nodes), [nodes]);

  useEffect(() => {
    // capture：与 OutlinePanel 同因（画布层 bubble 监听在特定焦点路径下抢跑）
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const focus = (id: string) => {
    // 再点同一集 = 退出聚焦（与「点卡片不改变聚焦」一致，避免无处可退）
    if (focusId === id) {
      onFocus(null);
      return;
    }
    onFocus(id);
    useCanvasStore.getState().selectNodes([id]);
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, {
        detail: { ids: nodesOfEpisode(nodes, id).map((n) => n.id) },
      }),
    );
  };

  return (
    <div className="absolute left-2 top-14 z-20 flex max-h-[62vh] w-72 flex-col rounded-lg border border-hairline bg-surface-1 p-2 shadow-lg">
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <Clapperboard className="h-3.5 w-3.5 text-text-3" />
        <span className="text-xs font-medium text-text">分集</span>
        <span className="text-[10px] text-text-4">
          共 {episodes.length} 集
        </span>
        {focusId ? (
          <button
            type="button"
            className="ml-1 rounded px-1 py-px text-[10px] text-accent transition-colors hover:bg-accent-dim"
            onClick={() => onFocus(null)}
            data-tip="退出聚焦（Esc 同）"
          >
            退出聚焦
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="关闭分集面板"
          className="rounded p-1 text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {episodes.length === 0 ? (
          <p className="px-1 py-3 text-center text-[11px] text-text-4">
            还没有剧本卡——一张剧本卡就是一集
          </p>
        ) : (
          <ul className="space-y-0.5">
            {episodes.map((n, i) => {
              const no = episodeNoOf({ data: n.data });
              const stats = episodeStatsLine(nodes, n.id);
              const active = focusId === n.id;
              return (
                <li key={n.id}>
                  <div
                    data-episode-id={n.id}
                    className={`group flex cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-1.5 transition-colors ${
                      active ? "bg-accent-dim" : "hover:bg-surface-2"
                    }`}
                    onClick={() => focus(n.id)}
                    data-tip="点击聚焦本集：运镜定位 + 压暗其余卡（再点一次退出）"
                  >
                    <span
                      className={`mt-px shrink-0 rounded px-1 py-px text-[10px] font-medium tabular-nums ${
                        no === null
                          ? "bg-surface-2 text-text-4"
                          : "bg-accent/10 text-accent"
                      }`}
                    >
                      {no === null ? "—" : `第 ${no} 集`}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-text">
                        {n.data.title || "（未命名）"}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-text-4">
                        {stats || "暂无产物"}
                      </span>
                    </span>
                    {/* ↑↓ 重排：整表按当前顺序归一到 1..N（缺号/重复号一次点击即归位） */}
                    <span className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        aria-label={`第 ${no ?? i + 1} 集上移`}
                        disabled={i === 0}
                        className="rounded p-0.5 text-text-4 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-30"
                        onClick={(e) => {
                          e.stopPropagation();
                          useCanvasStore.getState().moveEpisode(n.id, -1);
                        }}
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`第 ${no ?? i + 1} 集下移`}
                        disabled={i === episodes.length - 1}
                        className="rounded p-0.5 text-text-4 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-30"
                        onClick={(e) => {
                          e.stopPropagation();
                          useCanvasStore.getState().moveEpisode(n.id, 1);
                        }}
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="px-1 pt-1.5 text-[10px] leading-relaxed text-text-4">
        点击聚焦本集 · 悬停 ↑↓ 调集序 · 集号与「下载本集」按此顺序
      </p>
    </div>
  );
}
