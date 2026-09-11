"use client";

/**
 * AI 艺术评审弹窗（doc/image-node-ops-spec.md §10）：master-detail——
 * 左被评审图，右 findings 列表（四维 + 严重度 + 忽略切换）。骨架沿
 * ScriptReviewDialog（OverlayModal portal、severity 配色同源），无文本
 * 锚点高亮（评审对象是图，quote 是画面位置描述不是原文区间）。
 */
import { useMemo } from "react";
import {
  ClipboardCheck,
  Eye,
  Loader2,
  Move3d,
  Palette,
  Sun,
  X,
} from "lucide-react";
import OverlayModal from "./OverlayModal";
import {
  ART_DIMENSION_LABEL,
  ART_REVIEW_SEVERITY_LABEL,
  type ArtDimension,
  type ArtReviewFinding,
  type ArtReviewJob,
} from "@/lib/image-review";

const SEV_DOT: Record<string, string> = {
  high: "bg-danger",
  medium: "bg-warn",
  low: "bg-text-3",
};

const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/* 四维度图标走 lucide，与姊妹弹窗 ScriptReviewDialog 的 DIM_ICON 同族——
   此前这里是 ▣◐☀△ 一组 Unicode 字形：定形定尺、无法按状态换色，且与
   同功能的文本审查弹窗长得像两个产品（better-ui「one icon library per surface」） */
const DIM_ICON: Record<ArtDimension, typeof Eye> = {
  composition: Eye,
  color: Palette,
  lighting: Sun,
  proportion: Move3d,
};

export default function ImageReviewDialog({
  job,
  error,
  running,
  onClose,
  onDismiss,
}: {
  job: ArtReviewJob | null;
  error: string;
  running: boolean;
  onClose: () => void;
  onDismiss: (finding: ArtReviewFinding, dismissed: boolean) => void;
}) {
  const findings = useMemo(() => {
    const fs = job?.findings ?? [];
    return [...fs].sort(
      (a, b) =>
        SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
        (a.dismissed ? 1 : 0) - (b.dismissed ? 1 : 0),
    );
  }, [job?.findings]);
  const open = findings.filter((f) => !f.dismissed);
  const statusLine = error
    ? `评审失败：${error}`
    : running
      ? "评审中（四维一次评完，约 1-2 分钟）…"
      : job?.status === "done"
        ? `评审完成：${open.length} 条有效发现${findings.length > open.length ? `（已忽略 ${findings.length - open.length}）` : ""}`
        : job?.status === "stopped"
          ? "已取消"
          : job?.status === "interrupted"
            ? "agent 重启导致中断，请重新发起"
            : "";

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6 ws-scrim-in"
      onClick={running ? undefined : onClose}
    >
      <div
        className="flex h-[min(86vh,760px)] w-[min(92vw,1180px)] flex-col overflow-hidden ws-dialog-in ws-elev-modal rounded-xl bg-surface-1"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <ClipboardCheck className="h-4 w-4" />
              AI 艺术评审 · {job?.cardTitle || "图片"}
            </h3>
            <p className="mt-0.5 truncate text-[11px] text-text-4">{statusLine || " "}</p>
          </div>
          <button
            type="button"
            data-tip="关闭" aria-label="关闭"
            className="rounded p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 体：左图右 findings */}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[46%] shrink-0 items-center justify-center border-r border-hairline bg-surface-2/40 p-3">
            {job?.imageUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={job.imageUrl}
                alt={job.cardTitle}
                className="max-h-full max-w-full rounded-lg object-contain shadow"
              />
            ) : (
              <div className="flex items-center gap-2 text-xs text-text-4">
                <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
                载入中…
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {running ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-text-4">
                <Loader2 className="h-6 w-6 motion-safe:animate-spin" />
                <p className="text-xs">正在按 构图 / 色彩 / 光线 / 比例 四维评审…</p>
                {job?.log?.length ? (
                  <p className="max-w-[80%] text-center text-[10px] text-text-4/80">
                    {job.log[job.log.length - 1]?.text}
                  </p>
                ) : null}
              </div>
            ) : findings.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-text-4">
                {error ? "任务失败，可重新发起" : "四个维度都没有发现问题，这张图过关了"}
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {findings.map((f) => (
                  <li
                    key={f.id}
                    className={`rounded-lg border border-hairline bg-surface-2/50 p-2.5 transition-opacity ${
                      f.dismissed ? "opacity-45" : ""
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[f.severity] ?? "bg-text-3"}`} />
                      <span className="text-xs font-medium text-text">{f.title}</span>
                      <span className="flex items-center gap-1 rounded bg-surface-1 px-1 py-0.5 text-[9px] text-text-4">
                        {(() => {
                          const DimIcon = DIM_ICON[f.dimension];
                          return <DimIcon className="h-2.5 w-2.5" strokeWidth={1.5} />;
                        })()}
                        {ART_DIMENSION_LABEL[f.dimension]}
                      </span>
                      <span className="text-[9px] text-text-4">
                        {ART_REVIEW_SEVERITY_LABEL[f.severity]}危
                      </span>
                      <button
                        type="button"
                        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:bg-surface-1 hover:text-text"
                        onClick={() => onDismiss(f, !f.dismissed)}
                      >
                        {f.dismissed ? "恢复" : "忽略"}
                      </button>
                    </div>
                    {f.quote ? (
                      <p className="mt-1 text-[10px] text-text-4">位置：{f.quote}</p>
                    ) : null}
                    {f.detail ? (
                      <p className="mt-1 text-[11px] leading-relaxed text-text-2">{f.detail}</p>
                    ) : null}
                    {f.suggestion ? (
                      <p className="mt-1 rounded bg-surface-1/70 px-1.5 py-1 text-[11px] leading-relaxed text-text-2">
                        建议：{f.suggestion}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
