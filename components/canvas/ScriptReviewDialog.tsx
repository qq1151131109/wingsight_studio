"use client";

/**
 * 剧本审查弹窗：维度勾选 → 异步审查（后台 job + 轮询）→ master-detail 结果。
 * 左栏只读正文按 finding 锚点切 span 高亮（点右栏问题滚动定位）；右栏问题列表
 * 逐条 忽略/应用改写建议（应用走 store updateNodeData，可撤销）。
 * findings 真相在 agent review_jobs/review_findings 表（researchId 同范式），
 * 画布只存 reviewJobId 锚。锚点按当前正文本地重算（服务端区间是写入时的，
 * 剧本改过后以此处重算为准），指纹不一致时顶部横幅提醒建议重审。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Globe,
  Loader2,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";

import OverlayModal from "./OverlayModal";
import { useCanvasStore } from "@/lib/canvas/store";
import {
  cancelScriptReview,
  dismissScriptReviewFinding,
  getLatestScriptReview,
  getScriptReview,
  isReviewTerminal,
  REVIEW_DIMENSIONS,
  REVIEW_DIMENSION_DESC,
  REVIEW_DIMENSION_LABEL,
  REVIEW_SEVERITY_LABEL,
  REVIEW_STATUS_LABEL,
  startScriptReview,
  type ReviewDimension,
  type ReviewFinding,
  type ReviewJob,
  type ReviewStatus,
} from "@/lib/script-review";

const DIM_ICON: Record<ReviewDimension, typeof ShieldAlert> = {
  compliance: ShieldAlert,
  consistency: RotateCcw,
  fact: Globe,
};

const SEV_DOT: Record<string, string> = {
  high: "bg-danger",
  medium: "bg-warn",
  low: "bg-text-3",
};

const SEV_HL: Record<string, string> = {
  high: "bg-danger/25 ring-1 ring-danger/50",
  medium: "bg-warn/25 ring-1 ring-warn/50",
  low: "bg-text-3/20 ring-1 ring-text-3/40",
};

const STATUS_DOT: Record<ReviewStatus, string> = {
  queued: "bg-text-3",
  running: "bg-accent animate-pulse",
  done: "bg-good",
  error: "bg-danger",
  interrupted: "bg-warn",
  stopped: "bg-text-3",
};

/** 与 agent 端 _find_anchor 同款：精确找，失配按去空白容错（LLM 摘录合并换行）。 */
function findAnchor(body: string, quote: string): [number, number] {
  const idx = body.indexOf(quote);
  if (idx >= 0) return [idx, idx + quote.length];
  const q = quote.replace(/\s+/g, "");
  if (!q) return [-1, -1];
  const mapping: number[] = [];
  let stripped = "";
  for (let i = 0; i < body.length; i++) {
    if (!/\s/.test(body[i])) {
      mapping.push(i);
      stripped += body[i];
    }
  }
  const sidx = stripped.indexOf(q);
  if (sidx < 0) return [-1, -1];
  return [mapping[sidx], mapping[sidx + q.length - 1] + 1];
}

async function sha1Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function ScriptReviewDialog({
  projectId,
  nodeId,
  jobId: initialJobId,
  onClose,
}: {
  projectId: string;
  nodeId: string;
  /** 卡锚续开：直接打开指定任务；缺省拉该卡最新一次 */
  jobId?: string;
  onClose: () => void;
}) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const body = node?.data.body ?? "";
  const cardTitle = node?.data.title ?? "";
  const [loaded, setLoaded] = useState(false);
  const [job, setJob] = useState<ReviewJob | null>(null);
  const [selDims, setSelDims] = useState<Set<ReviewDimension>>(
    new Set(REVIEW_DIMENSIONS),
  );
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState("");
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const [busyFinding, setBusyFinding] = useState<string | null>(null);
  const [bodySha1, setBodySha1] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 首装：指定任务或该卡最新一次；都没有 → 维度勾选态
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const j = initialJobId
          ? await getScriptReview(projectId, initialJobId)
          : await (async () => {
              const s = await getLatestScriptReview(projectId, nodeId);
              return getScriptReview(projectId, s.jobId);
            })();
        if (!dead) {
          setJob(j);
          setSelDims(new Set(j.dimensions));
        }
      } catch {
        /* 没有审查记录 → 勾选态 */
      } finally {
        if (!dead) setLoaded(true);
      }
    })();
    return () => {
      dead = true;
    };
  }, [projectId, nodeId, initialJobId]);

  // 正文指纹（过期横幅用：与审查时不一致 = 剧本已改）
  useEffect(() => {
    let dead = false;
    void sha1Hex(body).then((h) => {
      if (!dead) setBodySha1(h);
    });
    return () => {
      dead = true;
    };
  }, [body]);

  // 运行中轮询（3s），GET 全量含 findings，终态即停
  const running = job?.status === "running" || job?.status === "queued";
  const pollJobId = running ? (job?.jobId ?? "") : "";
  useEffect(() => {
    if (!pollJobId) return;
    const t = setInterval(async () => {
      try {
        setJob(await getScriptReview(projectId, pollJobId));
      } catch {
        /* 轮询失败静默，下一轮再试 */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pollJobId, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 锚点按当前正文本地重算（服务端区间是写入时的；应用建议后正文会变）
  const findings = useMemo(() => job?.findings ?? [], [job]);
  const anchors = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const f of findings) m.set(f.id, findAnchor(body, f.quote));
    return m;
  }, [findings, body]);

  // 高亮区间：未忽略的 findings，按严重度优先占位、区间不重叠
  const visible = useMemo(
    () => findings.filter((f) => !f.dismissed && (anchors.get(f.id)?.[0] ?? -1) >= 0),
    [findings, anchors],
  );
  const segments = useMemo(() => {
    const sevRank = { high: 0, medium: 1, low: 2 } as const;
    const sorted = [...visible].sort(
      (a, b) =>
        sevRank[a.severity] - sevRank[b.severity] ||
        (anchors.get(a.id)?.[0] ?? 0) - (anchors.get(b.id)?.[0] ?? 0),
    );
    const taken: { id: string; start: number; end: number; severity: string }[] = [];
    for (const f of sorted) {
      const [s, e] = anchors.get(f.id)!;
      if (taken.some((t) => s < t.end && e > t.start)) continue;
      taken.push({ id: f.id, start: s, end: e, severity: f.severity });
    }
    taken.sort((a, b) => a.start - b.start);
    const parts: { text: string; hl?: (typeof taken)[number] }[] = [];
    let cur = 0;
    for (const t of taken) {
      if (t.start > cur) parts.push({ text: body.slice(cur, t.start) });
      parts.push({ text: body.slice(t.start, t.end), hl: t });
      cur = t.end;
    }
    if (cur < body.length) parts.push({ text: body.slice(cur) });
    return parts;
  }, [visible, anchors, body]);

  // 点右栏问题 → 左栏滚动定位
  useEffect(() => {
    if (!activeFinding) return;
    const el = bodyRef.current?.querySelector(`[data-finding="${activeFinding}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeFinding]);

  const start = async () => {
    if (starting || selDims.size === 0) return;
    setStarting(true);
    setStartErr("");
    try {
      const fresh = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const j = await startScriptReview(projectId, {
        nodeId,
        title: fresh?.data.title ?? "",
        body: fresh?.data.body ?? "",
        dimensions: [...selDims],
        textModel: (fresh?.data.textModel ?? "").trim() || undefined,
      });
      setJob(j);
    } catch (exc) {
      setStartErr(exc instanceof Error ? exc.message : "发起审查失败");
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      await cancelScriptReview(projectId, job.jobId);
    } catch (exc) {
      setStartErr(exc instanceof Error ? exc.message : "取消失败");
    }
  };

  const setDismissed = async (f: ReviewFinding, dismissed: boolean) => {
    if (!job) return;
    setBusyFinding(f.id);
    try {
      const updated = await dismissScriptReviewFinding(projectId, job.jobId, f.id, dismissed);
      setJob((prev) =>
        prev
          ? {
              ...prev,
              findings: (prev.findings ?? []).map((x) => (x.id === f.id ? updated : x)),
            }
          : prev,
      );
    } catch (exc) {
      setStartErr(exc instanceof Error ? exc.message : "更新失败");
    } finally {
      setBusyFinding(null);
    }
  };

  /** 应用改写建议：校验锚点仍指向引文 → 覆盖正文区间（默认 commit，可撤销）→ 忽略该条 */
  const applySuggestion = async (f: ReviewFinding) => {
    if (!job || !f.suggestion) return;
    const cur = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)?.data.body ?? "";
    const [s, e] = anchors.get(f.id) ?? [-1, -1];
    if (s < 0) {
      setStartErr("该问题的原文位置已失效（正文可能已改），请重新审查");
      return;
    }
    if (cur.slice(s, e).replace(/\s+/g, "") !== f.quote.replace(/\s+/g, "")) {
      setStartErr("正文已变化，为避免误改未应用；请重新审查");
      return;
    }
    setBusyFinding(f.id);
    try {
      useCanvasStore.getState().updateNodeData(nodeId, { body: cur.slice(0, s) + f.suggestion + cur.slice(e) });
      await setDismissedAfterApply(job.jobId, f.id);
    } finally {
      setBusyFinding(null);
    }
  };

  const setDismissedAfterApply = async (jobId: string, findingId: string) => {
    try {
      const updated = await dismissScriptReviewFinding(projectId, jobId, findingId, true);
      setJob((prev) =>
        prev
          ? {
              ...prev,
              findings: (prev.findings ?? []).map((x) => (x.id === findingId ? updated : x)),
            }
          : prev,
      );
    } catch {
      /* 忽略失败不影响应用本身 */
    }
  };

  const stale = loaded && !!job && isReviewTerminal(job.status) && !!job.bodySha1 && !!bodySha1 && job.bodySha1 !== bodySha1;
  const openCount = findings.filter((f) => !f.dismissed).length;
  const dimStates = job?.dims ?? {};

  const closeBtn = (
    <button
      type="button"
      data-tip="关闭" aria-label="关闭"
      className="rounded-md p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
      onClick={onClose}
    >
      <X className="h-4 w-4" />
    </button>
  );

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/55 p-6"
      onClick={running ? undefined : onClose}
    >
      <div
        className={`flex flex-col rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl ${
          loaded && !job
            ? "max-h-[86vh] w-[min(46rem,92vw)]"
            : "h-[min(86vh,880px)] w-[min(76rem,94vw)]"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-text">
              剧本审查
              {job ? (
                <span className="flex items-center gap-1 text-xs font-normal text-text-3">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[job.status]}`} />
                  {REVIEW_STATUS_LABEL[job.status]}
                  {cardTitle ? <span className="text-text-4">· {cardTitle.slice(0, 24)}</span> : null}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-[11px] text-text-4">
              合规（敏感词表底料+语境判定）/ 一致性（内部矛盾）/ 事实核查（联网取证），使用卡片所选文本模型
            </p>
          </div>
          {closeBtn}
        </div>

        {startErr ? (
          <p className="mt-2 shrink-0 text-[11px] text-danger">{startErr}</p>
        ) : null}

        {/* 未跑过：维度勾选 */}
        {loaded && !job ? (
          <div className="mt-4 flex flex-1 flex-col">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {REVIEW_DIMENSIONS.map((dim) => {
                const Icon = DIM_ICON[dim];
                const on = selDims.has(dim);
                return (
                  <button
                    key={dim}
                    type="button"
                    className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
                      on
                        ? "border-accent bg-accent/5"
                        : "border-hairline bg-surface-2/40 hover:border-accent/50"
                    }`}
                    onClick={() =>
                      setSelDims((prev) => {
                        const next = new Set(prev);
                        if (next.has(dim)) next.delete(dim);
                        else next.add(dim);
                        return next;
                      })
                    }
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium text-text">
                      <Icon className={`h-3.5 w-3.5 ${on ? "text-accent" : "text-text-3"}`} />
                      {REVIEW_DIMENSION_LABEL[dim]}
                      {on ? <Check className="ml-auto h-3.5 w-3.5 text-accent" /> : null}
                    </span>
                    <span className="text-[11px] leading-relaxed text-text-3">
                      {REVIEW_DIMENSION_DESC[dim]}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-auto flex justify-end pt-4">
              <button
                type="button"
                disabled={starting || selDims.size === 0}
                className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
                onClick={() => void start()}
              >
                {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                {starting ? "发起中…" : "开始审查"}
              </button>
            </div>
          </div>
        ) : null}

        {/* 运行中：逐维度进度 */}
        {job && running ? (
          <div className="mt-4 flex flex-1 flex-col">
            <div className="space-y-2">
              {Object.entries(dimStates).map(([dim, st]) => {
                const Icon = DIM_ICON[dim as ReviewDimension] ?? ShieldAlert;
                return (
                  <div
                    key={dim}
                    className="flex items-center gap-2 rounded-lg border border-hairline bg-surface-2/40 px-3 py-2 text-xs"
                  >
                    <Icon className="h-3.5 w-3.5 text-text-3" />
                    <span className="font-medium text-text">{REVIEW_DIMENSION_LABEL[dim as ReviewDimension] ?? dim}</span>
                    {st.state === "running" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                    ) : st.state === "pending" ? (
                      <span className="text-text-4">排队中</span>
                    ) : st.state === "done" ? (
                      <Check className="h-3.5 w-3.5 text-good" />
                    ) : (
                      <span className="text-danger">{st.error || "失败"}</span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[11px] text-text-4">
              事实核查需联网搜索取证，整体约 1~3 分钟；关闭弹窗不影响后台任务，完成后点「审查」回来查看
            </p>
            <div className="mt-auto flex justify-end pt-4">
              <button
                type="button"
                className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:border-danger hover:text-danger"
                onClick={() => void cancel()}
              >
                取消审查
              </button>
            </div>
          </div>
        ) : null}

        {/* 终态：master-detail */}
        {job && !running && isReviewTerminal(job.status) ? (
          <>
            {stale ? (
              <p className="mt-2 shrink-0 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
                剧本已改动：问题定位已按当前正文重算，但建议重新审查拿到与最新正文一致的结果
              </p>
            ) : null}
            {job.error ? (
              <p className="mt-2 shrink-0 text-[11px] text-warn">{job.error}</p>
            ) : null}
            <div className="mt-3 flex min-h-0 flex-1 gap-3">
              {/* 左：正文只读 + 高亮 */}
              <div
                ref={bodyRef}
                className="nowheel min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface-2/40 p-3 font-editorial text-xs leading-relaxed text-text-2"
              >
                {segments.length > 0
                  ? segments.map((seg, i) =>
                      seg.hl ? (
                        <span
                          key={i}
                          data-finding={seg.hl.id}
                          className={`cursor-pointer rounded-sm ${SEV_HL[seg.hl.severity] ?? SEV_HL.low} ${
                            activeFinding === seg.hl.id ? "ring-2 ring-accent" : ""
                          }`}
                          onClick={() => setActiveFinding(seg.hl!.id)}
                        >
                          {seg.text}
                        </span>
                      ) : (
                        <span key={i}>{seg.text}</span>
                      ),
                    )
                  : body}
              </div>
              {/* 右：问题列表 */}
              <div className="flex w-80 shrink-0 flex-col">
                <div className="flex items-center justify-between pb-2 text-[11px] text-text-4">
                  <span>
                    {job.status === "done"
                      ? openCount > 0
                        ? `${openCount} 条待处理`
                        : "未发现问题"
                      : "无结果"}
                  </span>
                  <span className="tabular-nums">
                    高 {findings.filter((f) => f.severity === "high" && !f.dismissed).length} · 中{" "}
                    {findings.filter((f) => f.severity === "medium" && !f.dismissed).length} · 低{" "}
                    {findings.filter((f) => f.severity === "low" && !f.dismissed).length}
                  </span>
                </div>
                <div className="nowheel min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
                  {findings.length === 0 ? (
                    <div className="flex h-32 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-hairline text-xs text-text-4">
                      <Check className="h-5 w-5 text-good" />
                      {job.status === "done" ? "未发现问题" : "没有可展示的结果"}
                    </div>
                  ) : null}
                  {findings.map((f) => {
                    const Icon = DIM_ICON[f.dimension] ?? ShieldAlert;
                    return (
                      <div
                        key={f.id}
                        className={`rounded-lg border p-2.5 text-xs transition-colors ${
                          activeFinding === f.id
                            ? "border-accent bg-accent/5"
                            : "border-hairline bg-surface-2/40 hover:border-accent/40"
                        } ${f.dismissed ? "opacity-50" : ""}`}
                        onClick={() => setActiveFinding(f.id)}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[f.severity] ?? "bg-text-3"}`} />
                          <Icon className="h-3 w-3 shrink-0 text-text-3" />
                          <span className="text-text-3">{REVIEW_DIMENSION_LABEL[f.dimension] ?? f.dimension}</span>
                          {f.category ? (
                            <span className="rounded bg-surface-2 px-1 py-px text-[10px] text-text-2">{f.category}</span>
                          ) : null}
                          <span className="ml-auto shrink-0 text-[10px] text-text-4">
                            {REVIEW_SEVERITY_LABEL[f.severity] ?? f.severity}
                          </span>
                        </div>
                        <p className="mt-1.5 border-l-2 border-hairline pl-2 text-[11px] italic leading-relaxed text-text-3">
                          {f.quote}
                        </p>
                        <p className="mt-1.5 leading-relaxed text-text-2">{f.message}</p>
                        {f.relatedQuote ? (
                          <p className="mt-1 text-[11px] leading-relaxed text-text-3">
                            <span className="text-text-4">矛盾处：</span>
                            {f.relatedQuote}
                          </p>
                        ) : null}
                        {f.suggestion ? (
                          <p className="mt-1.5 rounded bg-accent/10 px-2 py-1.5 leading-relaxed text-text-2">
                            <span className="text-accent">建议：</span>
                            {f.suggestion}
                          </p>
                        ) : null}
                        {f.evidence.length > 0 ? (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {f.evidence.map((ev) => (
                              <a
                                key={ev.sid}
                                href={ev.url}
                                target="_blank"
                                rel="noreferrer"
                                className="max-w-[13rem] truncate rounded border border-hairline px-1 py-px text-[10px] text-text-3 hover:border-accent hover:text-accent"
                                onClick={(e) => e.stopPropagation()}
                                data-tip={ev.title || ev.url}
                              >
                                {ev.sid} {ev.title || ev.url}
                              </a>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 flex items-center gap-2 text-[10px]">
                          {f.suggestion && !f.dismissed ? (
                            <button
                              type="button"
                              disabled={busyFinding === f.id}
                              className="rounded border border-accent/50 px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                              onClick={(e) => {
                                e.stopPropagation();
                                void applySuggestion(f);
                              }}
                            >
                              {busyFinding === f.id ? "应用中…" : "应用建议"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={busyFinding === f.id}
                            className="rounded border border-hairline px-1.5 py-0.5 text-text-3 transition-colors hover:text-text disabled:opacity-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              void setDismissed(f, !f.dismissed);
                            }}
                          >
                            {f.dismissed ? "取消忽略" : "忽略"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {/* 底部 */}
            <div className="mt-3 flex shrink-0 items-center justify-between">
              <span className="text-[11px] text-text-4">
                {job.textModel ? `模型 ${job.textModel} · ` : ""}
                {job.bodyChars} 字 · 审查于 {job.createdAt.slice(0, 16).replace("T", " ")}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:border-accent hover:text-text"
                  onClick={() => setJob(null)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  重新审查
                </button>
                <button
                  type="button"
                  className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2/70"
                  onClick={onClose}
                >
                  关闭
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </OverlayModal>
  );
}
