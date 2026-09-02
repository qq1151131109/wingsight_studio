"use client";

/**
 * 参考图调研面板：Google 图片搜索经 Serper 号池轮转（key 在管理后台维护），
 * 人工勾选采纳（一期不做视觉自动复核）。采纳 = 候选标记 + 自动建图片卡
 * 连线到资产卡（连线即参考，directImagegen 参考序列自动收上游连线卡）。
 */

import { Loader2, Search, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import OverlayModal from "./OverlayModal";
import { assetThumbUrl } from "@/lib/asset-thumb";
import { NODE_FOOTPRINT, absolutePosition, nodeSize, useCanvasStore } from "@/lib/canvas/store";
import {
  MAX_ADOPT_PER_NODE,
  adoptRefCandidates,
  deleteRefCandidate,
  listRefCandidates,
  runRefResearch,
  type RefCandidate,
} from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";

export default function RefResearchDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const projectId = useCanvasStore((s) => s.projectId);
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const assetTitle = node?.data.title ?? "";
  const [queries, setQueries] = useState(assetTitle);
  const [candidates, setCandidates] = useState<RefCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [channelErrors, setChannelErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const pid = projectId ?? "";

  useEffect(() => {
    if (!pid) return;
    void (async () => {
      try {
        setCandidates(await listRefCandidates(pid, nodeId));
      } catch (exc) {
        setErr(exc instanceof Error ? exc.message : "候选列表加载失败");
      }
    })();
  }, [pid, nodeId]);

  const adoptedIds = new Set(
    candidates.filter((c) => c.adopted).map((c) => c.id),
  );

  const search = async () => {
    const text = queries.trim();
    // 搜索词留空 = AI 生成（需要资产设定描述）；填了 = 手工词首轮直用
    const manual = text
      ? text.split(/[\s，、,]+/).filter(Boolean).slice(0, 5)
      : [];
    const asset = {
      name: assetTitle || "资产",
      type: String(node?.data.nodeType ?? "character"),
      description: `${assetTitle || ""}。${String(node?.data.body ?? "")}`.trim(),
    };
    if (!manual.length && !String(node?.data.body ?? "").trim()) {
      setErr("AI 生成搜索词需要卡上有设定描述：请先填写资产正文，或在输入框手填搜索词");
      return;
    }
    setRunning(true);
    setErr("");
    try {
      const job = await runRefResearch(pid, nodeId, manual, asset);
      setCandidates(job.candidates);
      setNote(job.note ?? "");
      // 推荐候选预勾选（采纳权在用户：可增删后一键采纳）
      setSelected(
        new Set(job.candidates.filter((c) => c.recommended).map((c) => c.id)),
      );
      setChannelErrors(job.errors ?? {});
      if (job.status === "error" || job.error) setErr(job.error);
      // 候选落库：刷新资产卡「N 张待选」徽标
      void useRefStatusStore.getState().refresh(pid, { force: true });
    } catch (exc) {
      setErr(exc instanceof Error ? exc.message : "调研失败");
    } finally {
      setRunning(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_ADOPT_PER_NODE) next.add(id);
      return next;
    });
  };

  const adopt = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setAdopting(true);
    setErr("");
    try {
      const adoptedRows = await adoptRefCandidates(pid, nodeId, ids);
      // 建参考卡并连线（source=参考卡 → target=资产卡），一行排在本卡正下方
      const st = useCanvasStore.getState();
      const asset = st.nodes.find((n) => n.id === nodeId);
      // 组框内的卡 position 是相对坐标，落位必须换算绝对坐标
      const origin = asset ? absolutePosition(st.nodes, asset) : { x: 0, y: 0 };
      const size = asset ? nodeSize(asset) : NODE_FOOTPRINT.image;
      const fp = NODE_FOOTPRINT.image;
      const created: string[] = [];
      adoptedRows.forEach((c, i) => {
        const newId = st.addNode({
          position: {
            x: origin.x + i * (fp.w + 24),
            y: origin.y + size.h + 48,
          },
          style: { width: fp.w, height: fp.h },
          data: {
            nodeType: "image",
            title: (c.title || "参考图").slice(0, 40),
            body: c.sourceDomain ? `来源：${c.sourceDomain}` : "",
            imageUrl: c.assetUrl,
            status: "ready",
            // 考据参考标记：出图职责段按「锁定形制材质」而非「保留构图改图」渲染
            refSource: "research",
          },
        });
        created.push(newId);
        st.connect({ source: newId, target: nodeId });
      });
      if (created.length) st.flashNodes(created);
      const adoptedIdSet = new Set(adoptedRows.map((c) => c.id));
      setCandidates((prev) =>
        prev.map((c) => (adoptedIdSet.has(c.id) ? { ...c, adopted: true } : c)),
      );
      setSelected(new Set());
      // 已采纳计数变了：刷新资产卡「N 张待选」徽标
      void useRefStatusStore.getState().refresh(pid, { force: true });
    } catch (exc) {
      setErr(exc instanceof Error ? exc.message : "采纳失败");
    } finally {
      setAdopting(false);
    }
  };

  const remove = async (c: RefCandidate) => {
    if (!window.confirm(`删除候选「${c.title.slice(0, 30)}」？已建的参考卡不受影响。`)) return;
    try {
      await deleteRefCandidate(pid, c.id);
      setCandidates((prev) => prev.filter((x) => x.id !== c.id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(c.id);
        return next;
      });
      void useRefStatusStore.getState().refresh(pid, { force: true });
    } catch (exc) {
      setErr(exc instanceof Error ? exc.message : "删除失败");
    }
  };

  return (
    <OverlayModal
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-6"
      onClick={running || adopting ? undefined : onClose}
    >
      <div
        className="flex max-h-[86vh] w-[min(46rem,92vw)] flex-col rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-text">找参考图</p>
            <p className="mt-0.5 text-[11px] text-text-4">
              AI 生成搜索词（清空输入框）或手填，多渠道搜回后由模型终选适合做生图参考的候选；
              采纳后自动建参考卡连线到「{assetTitle || "本卡"}」
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
        <div className="mt-3 flex gap-2">
          <input
            value={queries}
            onChange={(e) => setQueries(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !running) void search();
            }}
            placeholder="留空 = AI 按设定生成搜索词；或手填，空格分隔最多 5 个"
            maxLength={120}
            className="w-full rounded-md border border-hairline bg-surface-2/60 px-2 py-1.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
          />
          <button
            type="button"
            disabled={running || adopting}
            className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => void search()}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            {running ? "调研中…" : "搜索"}
          </button>
        </div>
        {note ? (
          <p className="mt-2 shrink-0 text-[11px] text-text-3">
            <span className="font-medium text-text-2">终选说明：</span>
            {note}
          </p>
        ) : null}
        {Object.entries(channelErrors).length ? (
          <div className="mt-2 space-y-0.5">
            {Object.entries(channelErrors).map(([channel, msg]) => (
              <p key={channel} className="text-[11px] text-warn">
                {channel}：{msg}
              </p>
            ))}
          </div>
        ) : null}
        <div className="nowheel mt-3 min-h-40 flex-1 overflow-y-auto">
          {candidates.length === 0 && !running ? (
            <p className="flex h-32 items-center justify-center text-xs text-text-4">
              还没有候选图。清空输入框点「搜索」让 AI 出词，或手填关键词（历史候选保留在这里）
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {[...candidates]
                .sort((a, b) => Number(b.recommended) - Number(a.recommended))
                .map((c) => {
                const isAdopted = adoptedIds.has(c.id);
                const isSelected = selected.has(c.id);
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    className={`group relative overflow-hidden rounded-md border transition-colors ${
                      isAdopted
                        ? "border-accent"
                        : isSelected
                          ? "border-accent-soft"
                          : "border-hairline hover:border-accent-soft"
                    }`}
                    onClick={() => {
                      if (!isAdopted) toggle(c.id);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !isAdopted) {
                        toggle(c.id);
                      }
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={assetThumbUrl(c.assetUrl)}
                      alt={c.title}
                      className="h-28 w-full bg-surface-2 object-cover"
                      loading="lazy"
                    />
                    {isAdopted ? (
                      <span className="absolute left-1 top-1 rounded bg-accent px-1 py-0.5 text-[9px] font-medium text-surface-1">
                        已采纳
                      </span>
                    ) : (
                      <span
                        className={`absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${
                          isSelected
                            ? "border-accent bg-accent text-surface-1"
                            : "border-white/60 bg-black/30 text-transparent group-hover:border-white"
                        }`}
                      >
                        ✓
                      </span>
                    )}
                    {!isAdopted && c.recommended ? (
                      <span
                        className="absolute left-1 top-1 rounded bg-accent/90 px-1 py-0.5 text-[9px] font-medium text-surface-1"
                        title={c.recReason || "AI 判定适合做生图参考"}
                      >
                        ★ 推荐
                      </span>
                    ) : null}
                    <button
                      type="button"
                      data-tip="删除候选" aria-label="删除候选"
                      className="nodrag absolute bottom-1 right-1 hidden rounded bg-black/50 p-0.5 text-white hover:bg-danger/80 group-hover:block"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(c);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                    <div className="border-t border-hairline-soft bg-surface-1 px-1.5 py-1">
                      <p className="truncate text-[10px] text-text-2" title={c.title}>
                        {c.title}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-[9px] text-text-4">
                        <span className="rounded bg-surface-2 px-1 py-px">{c.provider}</span>
                        {c.width > 0 && c.height > 0 ? <span>{c.width}×{c.height}</span> : null}
                        {c.pageUrl ? (
                          <a
                            href={c.pageUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate hover:text-accent"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {c.sourceDomain || "来源页"}
                          </a>
                        ) : null}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {err ? <p className="mt-2 shrink-0 text-[11px] text-danger">{err}</p> : null}
        <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
          <p className="text-[10px] text-text-4">
            生效张数随出图模型：默认上限 4 张，Seedream 5 Pro 融合通道 10 张
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
              onClick={onClose}
            >
              关闭
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || adopting || running}
              className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={() => void adopt()}
            >
              {adopting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              采纳为参考图{selected.size ? `（${selected.size}）` : ""}
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
