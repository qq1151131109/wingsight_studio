"use client";

/**
 * 批量调研审阅面板：按资产分组展示候选，供快速过一遍调研结果。
 * 每行 = 一个资产：候选横排缩略图（多选，AI 推荐预选）、重搜、清空。
 * 快速调整 = 点图切换选中；删除 = 取消选中或「清空」；重搜 = 行内重新调研。
 * 确认后按选中批量建参考卡连线（生效于出图参考序列），供「补资产图」使用。
 */

import { Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";

import OverlayModal from "./OverlayModal";
import { assetThumbUrl } from "@/lib/asset-thumb";
import { adoptRefRows, } from "@/lib/canvas/refAdopt";
import { useCanvasStore } from "@/lib/canvas/store";
import {
  listRefCandidates,
  runRefResearch,
  type BatchRefJob,
  type RefAsset,
  type RefCandidate,
} from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";

export default function RefReviewDialog({
  projectId,
  batch,
  onClose,
}: {
  projectId: string;
  batch: BatchRefJob;
  onClose: () => void;
}) {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const [rows, setRows] = useState<
    Map<
      string,
      {
        name: string;
        type: string;
        candidates: RefCandidate[];
        selected: Set<string>;
        loading: boolean;
        error: string;
        brief: string;
      }
    >
  >(new Map());
  const [adopting, setAdopting] = useState(false);
  const [err, setErr] = useState("");
  const [doneMsg, setDoneMsg] = useState("");

  // 装载：batch 各资产终态后拉全量候选（含历史），推荐预选
  useEffect(() => {
    void (async () => {
      const next = new Map();
      for (const item of batch.items) {
        try {
          const candidates = await listRefCandidates(projectId, item.nodeId);
          next.set(item.nodeId, {
            name: item.name,
            type: "character",
            candidates,
            selected: new Set(
              candidates.filter((c) => c.recommended).map((c) => c.id),
            ),
            loading: false,
            // 批量条目软失败（如终选失败：候选在但无推荐预选）照显警示
            error: item.error || "",
            brief: item.brief || "",
          });
        } catch (exc) {
          next.set(item.nodeId, {
            name: item.name,
            type: "character",
            candidates: [],
            selected: new Set(),
            loading: false,
            error: exc instanceof Error ? exc.message : "候选加载失败",
            brief: item.brief || "",
          });
        }
      }
      setRows(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, batch.batchId]);

  const toggle = (nodeId: string, cid: string) => {
    setRows((prev) => {
      const row = prev.get(nodeId);
      if (!row) return prev;
      const selected = new Set(row.selected);
      if (selected.has(cid)) selected.delete(cid);
      else selected.add(cid);
      return new Map(prev).set(nodeId, { ...row, selected });
    });
  };

  /** 行内重搜：单资产 AI 出词重新调研，完成后刷新该行候选并重置预选 */
  const reSearch = async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    const asset: RefAsset = {
      name: String(node?.data.title || "资产"),
      type: String(node?.data.nodeType || "character"),
      description: `${node?.data.title || ""}。${String(node?.data.body || "")}`.trim(),
    };
    setRows((prev) => new Map(prev).set(nodeId, { ...prev.get(nodeId)!, loading: true, error: "" }));
    try {
      const job = await runRefResearch(projectId, nodeId, [], asset);
      const candidates = job.candidates;
      setRows((prev) =>
        new Map(prev).set(nodeId, {
          ...prev.get(nodeId)!,
          candidates,
          selected: new Set(candidates.filter((c) => c.recommended).map((c) => c.id)),
          loading: false,
          brief: job.researchBrief || prev.get(nodeId)!.brief,
        }),
      );
      // 候选落库：刷新资产卡「N 张待选」徽标
      void useRefStatusStore.getState().refresh(projectId, { force: true });
    } catch (exc) {
      setRows((prev) =>
        new Map(prev).set(nodeId, {
          ...prev.get(nodeId)!,
          loading: false,
          error: exc instanceof Error ? exc.message : "重搜失败",
        }),
      );
    }
  };

  const adopt = () => {
    const rowsOut = [...rows.entries()]
      .filter(([, row]) => row.selected.size > 0)
      .map(([nodeId, row]) => ({
        nodeId,
        candidates: row.candidates.filter((c) => row.selected.has(c.id)),
      }));
    if (!rowsOut.length) return;
    setAdopting(true);
    try {
      const created = adoptRefRows(rowsOut);
      if (created.length) useCanvasStore.getState().flashNodes(created);
      const assetCount = rowsOut.length;
      setDoneMsg(
        `已为 ${assetCount} 个资产建参考卡连线。点「补资产图」批量生图时将带上这些参考图。`,
      );
      setRows(new Map());
      // 已采纳计数变了：刷新资产卡「N 张待选」徽标
      void useRefStatusStore.getState().refresh(
        useCanvasStore.getState().projectId ?? "",
        { force: true },
      );
      setTimeout(onClose, 1600);
    } catch (exc) {
      setErr(exc instanceof Error ? exc.message : "采纳失败");
    } finally {
      setAdopting(false);
    }
  };

  const totalSelected = [...rows.values()].reduce(
    (sum, r) => sum + r.selected.size,
    0,
  );
  const assetsWithSelection = [...rows.values()].filter(
    (r) => r.selected.size > 0,
  ).length;

  /** 已采纳过（画布上有考据参考卡连线）的资产淡化显示 */
  const adoptedAssetIds = new Set(
    edges
      .filter((e) => {
        const src = nodes.find((n) => n.id === e.source);
        return src?.data.refSource === "research";
      })
      .map((e) => e.target),
  );

  return (
    <OverlayModal
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-6"
      onClick={adopting ? undefined : onClose}
    >
      <div
        className="flex max-h-[88vh] w-[min(60rem,94vw)] flex-col rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-text">调研结果审阅</p>
            <p className="mt-0.5 text-[11px] text-text-4">
              每个资产勾选合适的参考图（AI 推荐已预选，点图切换/取消），不合适的直接不勾；
              采纳后建参考卡连线，出图时进参考序列
            </p>
          </div>
          <button
            type="button"
            data-tip="关闭" aria-label="关闭"
            className="rounded-md p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="nowheel mt-3 min-h-40 flex-1 space-y-3 overflow-y-auto pr-1">
          {[...rows.entries()].map(([nodeId, row]) => {
            const adopted = adoptedAssetIds.has(nodeId);
            return (
              <div
                key={nodeId}
                className={`rounded-lg border border-hairline-soft bg-surface-2/40 p-2.5 ${
                  adopted ? "opacity-70" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text">{row.name}</span>
                  {adopted ? (
                    <span className="rounded bg-accent/90 px-1 py-px text-[9px] font-medium text-surface-1">
                      已有参考
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  <button
                    type="button"
                    disabled={row.loading}
                    data-tip="AI 换个角度重新调研此资产" aria-label="重新调研"
                    className="flex items-center gap-1 rounded border border-hairline px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:border-accent-soft hover:text-text disabled:opacity-50"
                    onClick={() => void reSearch(nodeId)}
                  >
                    {row.loading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    重搜
                  </button>
                  {row.selected.size > 0 ? (
                    <button
                      type="button"
                      data-tip="全部不勾（该资产不采纳参考图）" aria-label="清空选中"
                      className="rounded border border-hairline px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:border-danger hover:text-danger"
                      onClick={() =>
                        setRows((prev) =>
                          new Map(prev).set(nodeId, {
                            ...prev.get(nodeId)!,
                            selected: new Set(),
                          }),
                        )
                      }
                    >
                      清空
                    </button>
                  ) : null}
                </div>
                {row.error ? (
                  <p className="mt-1 text-[11px] text-danger">{row.error}</p>
                ) : null}
                {row.brief ? (
                  <details className="mt-1.5 rounded border border-hairline bg-surface-2/60">
                    <summary className="cursor-pointer select-none px-1.5 py-1 text-[10px] text-text-3 hover:text-text-2">
                      考据简报（本次调研的文字依据，已同步到资产卡）
                    </summary>
                    <p className="max-h-32 overflow-auto whitespace-pre-wrap px-1.5 pb-1.5 text-[10px] leading-relaxed text-text-3">
                      {row.brief}
                    </p>
                  </details>
                ) : null}
                {row.candidates.length === 0 && !row.loading ? (
                  <p className="mt-2 text-[11px] text-text-4">
                    没有候选（可点「重搜」换角度再来）
                  </p>
                ) : (
                  <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                    {row.candidates.map((c) => {
                      const isSelected = row.selected.has(c.id);
                      return (
                        <div
                          key={c.id}
                          role="button"
                          tabIndex={0}
                          title={c.title}
                          className={`relative w-24 shrink-0 cursor-pointer overflow-hidden rounded border transition-colors ${
                            isSelected
                              ? "border-accent"
                              : "border-hairline opacity-70 hover:opacity-100"
                          }`}
                          onClick={() => toggle(nodeId, c.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") toggle(nodeId, c.id);
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={assetThumbUrl(c.assetUrl)}
                            alt={c.title}
                            className="h-16 w-full bg-surface-2 object-contain"
                            loading="lazy"
                          />
                          {c.recommended ? (
                            <span className="absolute left-0.5 top-0.5 rounded bg-accent/90 px-0.5 text-[8px] font-medium text-surface-1">
                              ★
                            </span>
                          ) : null}
                          {isSelected ? (
                            <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[8px] text-surface-1">
                              ✓
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {err ? <p className="mt-2 shrink-0 text-[11px] text-danger">{err}</p> : null}
        {doneMsg ? (
          <p className="mt-2 shrink-0 text-[11px] text-accent">{doneMsg}</p>
        ) : null}
        <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
          <p className="text-[10px] text-text-4">
            采纳张数随出图模型上限（默认 4 / Seedream 5 Pro 10），超出部分出图时按序截断
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
              onClick={onClose}
            >
              稍后处理
            </button>
            <button
              type="button"
              disabled={adopting || totalSelected === 0}
              className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={adopt}
            >
              {adopting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              采纳为参考图{assetsWithSelection ? `（${assetsWithSelection} 资产 · ${totalSelected} 张）` : ""}
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
