"use client";

/**
 * 深度调研卷宗阅读器：全屏 overlay（OverlayModal 范式）。
 * 调研卡是画布锚点，长文阅读进这里——卷宗五段（叙事脊/已证实事实/真实争议/
 * 风险/材料簇）+ 来源底账 + 过程时间线；S 编号引用悬停看来源卡、点击开原文。
 * 补研（gap）在这里发起：定点追加问题，证据写父任务底账，卷宗重写不重跑全查。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Download,
  Loader2,
  Plus,
  X,
  XCircle,
} from "lucide-react";

import OverlayModal from "./OverlayModal";
import {
  RESEARCH_DEPTH_LABEL,
  RESEARCH_STAGE_LABEL,
  RESEARCH_STATUS_LABEL,
  type ResearchDossier,
  type ResearchJob,
  type ResearchSource,
  cancelResearch as cancelResearchApi,
  dossierToMarkdown,
  gapResearch,
  getResearch,
  listResearchSources,
} from "@/lib/research";

type Tab = "dossier" | "sources" | "log";

const STATUS_DOT: Record<string, string> = {
  planning: "var(--color-warn)",
  running: "var(--color-accent)",
  done: "var(--color-good)",
  error: "var(--color-danger)",
  interrupted: "var(--color-warn)",
  stopped: "var(--color-text-3)",
};

/** S 编号引用 chip：悬停浮出来源卡，点击开原文（deer-flow citation 范式的纸感版） */
function RefChip({
  sid,
  source,
}: {
  sid: string;
  source: ResearchSource | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="mx-0.5 inline-flex h-[18px] min-w-[24px] items-center justify-center rounded border border-hairline bg-surface-2 px-1 align-super text-[9px] font-medium tabular-nums text-text-3 transition-colors hover:border-accent hover:text-accent"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (source) window.open(source.url, "_blank", "noopener");
        }}
        data-tip={source ? `${sid} ${source.title.slice(0, 30)}` : `${sid}（来源清单未收录）`}
        aria-label={`来源 ${sid}`}
      >
        {sid.replace("S", "")}
      </button>
      {open && source ? (
        <span className="absolute bottom-full left-1/2 z-10 mb-1 w-64 -translate-x-1/2 rounded-lg border border-hairline bg-surface-1 p-2 text-left shadow-xl">
          <span className="line-clamp-2 block text-[10px] font-medium text-text">
            {source.title}
          </span>
          <span className="mt-0.5 block text-[9px] text-text-4">
            {sid} · {source.category}
            {source.fetchStatus === "snippet" ? " · 摘要级" : ""} · {source.domain}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function Cite({ refs, sources }: { refs: string[]; sources: ResearchSource[] }) {
  if (!refs.length) return null;
  const map = new Map(sources.map((s) => [s.sid, s]));
  return (
    <span className="ml-1 inline-flex gap-0.5">
      {refs.map((r) => (
        <RefChip key={r} sid={r} source={map.get(r)} />
      ))}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-4">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function ResearchReader({
  projectId,
  researchId,
  onClose,
}: {
  projectId: string;
  researchId: string;
  onClose: () => void;
}) {
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("dossier");
  const [copied, setCopied] = useState(false);
  const [gapInput, setGapInput] = useState("");
  const [gapJobId, setGapJobId] = useState("");
  const [gapErr, setGapErr] = useState("");
  const gapPolling = useRef(false);

  const active = job ? job.status === "running" || job.status === "planning" : true;

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const j = await getResearch(projectId, researchId);
        if (dead) return;
        setJob(j);
        setErr("");
        if (j.dossier || j.status !== "running") {
          const s = await listResearchSources(projectId, researchId);
          if (!dead) setSources(s);
        }
      } catch (exc) {
        if (!dead) setErr(exc instanceof Error ? exc.message : "加载失败");
      }
    };
    void load();
    return () => {
      dead = true;
    };
  }, [projectId, researchId]);

  // 运行中轮询（4s）；补研任务完成后刷新父任务卷宗
  useEffect(() => {
    if (!active && !gapJobId) return;
    const t = setInterval(async () => {
      try {
        if (gapJobId) {
          const g = await getResearch(projectId, gapJobId);
          if (g.status === "done") {
            setGapJobId("");
            const j = await getResearch(projectId, researchId);
            setJob(j);
            setSources(await listResearchSources(projectId, researchId));
          } else if (g.status === "error") {
            setGapErr(g.error || "补研失败");
            setGapJobId("");
          }
          return;
        }
        const j = await getResearch(projectId, researchId);
        setJob(j);
        if (j.status !== "running" && j.status !== "planning") {
          setSources(await listResearchSources(projectId, researchId));
        }
      } catch {
        /* 轮询失败静默，下一轮再试 */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [active, gapJobId, projectId, researchId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const markdown = useMemo(
    () => (job ? dossierToMarkdown(job, sources) : ""),
    [job, sources],
  );

  const copyAll = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const exportMd = () => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `调研卷宗-${job?.topic || researchId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startGap = async () => {
    const questions = gapInput
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean);
    if (!questions.length) return;
    gapPolling.current = true;
    setGapErr("");
    try {
      const g = await gapResearch(projectId, researchId, questions);
      setGapJobId(g.jobId);
      setGapInput("");
    } catch (exc) {
      setGapErr(exc instanceof Error ? exc.message : "补研发起失败");
    } finally {
      gapPolling.current = false;
    }
  };

  const dossier: ResearchDossier | null = job?.dossier ?? null;

  return (
    <OverlayModal
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[min(88vh,1000px)] w-[min(92vw,1400px)] flex-col rounded-xl border border-hairline bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 状态 + 动作 */}
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-text">
              <BookOpen className="h-4 w-4 shrink-0 text-accent" />
              <span className="truncate">{job?.topic || "调研卷宗"}</span>
              {job ? (
                <span
                  className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: STATUS_DOT[job.status] }}
                  data-tip={RESEARCH_STATUS_LABEL[job.status]}
                />
              ) : null}
              {job ? (
                <span className="shrink-0 text-[10px] font-normal text-text-4">
                  {RESEARCH_STATUS_LABEL[job.status]}
                  {job.status === "running" && job.stage
                    ? ` · ${RESEARCH_STAGE_LABEL[job.stage] || job.stage}（第 ${job.roundsDone}/${job.roundsTotal} 轮）`
                    : ""}
                  {" · "}
                  {RESEARCH_DEPTH_LABEL[job.depth]}
                  {" · 来源 "}
                  {job.sourcesCount}
                  {" · 事实 "}
                  {job.findingsCount}
                </span>
              ) : null}
            </p>
            {job?.plan ? (
              <p className="mt-0.5 truncate text-[11px] text-text-3">
                观看问题：{job.plan.viewingQuestion}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {job?.status === "running" ? (
              <button
                type="button"
                data-tip="取消调研" aria-label="取消调研"
                className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-danger"
                onClick={() => void cancelResearchApi(projectId, researchId)}
              >
                <XCircle className="h-4 w-4" />
              </button>
            ) : null}
            {markdown ? (
              <>
                <button
                  type="button"
                  data-tip={copied ? "已复制" : "复制全文 Markdown"} aria-label="复制全文"
                  className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
                  onClick={() => void copyAll()}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-good" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  data-tip="导出 Markdown" aria-label="导出 Markdown"
                  className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
                  onClick={exportMd}
                >
                  <Download className="h-4 w-4" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              data-tip="关闭" aria-label="关闭"
              className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tab 栏 */}
        <div className="flex items-center gap-1 border-b border-hairline px-5 pt-2">
          {(
            [
              ["dossier", "卷宗"],
              ["sources", `来源 ${job?.sourcesCount ?? ""}`],
              ["log", "过程"],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`rounded-t-md px-3 py-1.5 text-xs transition-colors ${
                tab === key
                  ? "border-b-2 border-accent font-medium text-text"
                  : "text-text-3 hover:text-text"
              }`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 正文 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {err ? (
            <p className="mt-8 text-center text-xs text-danger">{err}</p>
          ) : !job ? (
            <p className="mt-8 flex items-center justify-center gap-2 text-xs text-text-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中
            </p>
          ) : tab === "dossier" ? (
            <>
              {job.status === "planning" ? (
                <div className="mt-6">
                  <p className="text-xs text-text-3">开题待确认（在聊天里确认后开始执行）。</p>
                  {job.plan ? (
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-text-2">
                      {job.plan.directions.map((d) => (
                        <li key={d.title}>
                          <span className="font-medium text-text">{d.title}</span>
                          <span className="text-text-3">——{d.goal}</span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              ) : dossier ? (
                <>
                  <h2 className="font-editorial text-lg font-semibold text-text">
                    {dossier.headline}
                  </h2>
                  <p className="ws-detail mt-1.5 text-xs leading-relaxed text-text-2">
                    {dossier.summary}
                  </p>
                  {dossier.narrativeSpine.length ? (
                    <Section title="叙事脊（讲法建议，非场序）">
                      <ol className="space-y-2">
                        {dossier.narrativeSpine.map((s, i) => (
                          <li key={i} className="flex gap-2 text-xs leading-relaxed">
                            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[9px] font-semibold tabular-nums text-accent">
                              {i + 1}
                            </span>
                            <span className="text-text-2">
                              <span className="font-medium text-text">{s.step}</span>
                              {s.detail ? ` — ${s.detail}` : ""}
                              <Cite refs={s.refs} sources={sources} />
                            </span>
                          </li>
                        ))}
                      </ol>
                    </Section>
                  ) : null}
                  {dossier.establishedFacts.length ? (
                    <Section title="已证实事实边界">
                      <ul className="space-y-1.5">
                        {dossier.establishedFacts.map((f, i) => (
                          <li key={i} className="flex gap-2 text-xs leading-relaxed text-text-2">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-good" />
                            <span>
                              {f.text}
                              <Cite refs={f.refs} sources={sources} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null}
                  {dossier.controversies.length ? (
                    <Section title="真实争议（双版本对质，不定论）">
                      <div className="space-y-3">
                        {dossier.controversies.map((c, i) => (
                          <div key={i} className="rounded-lg border border-hairline bg-surface-2/40 p-3">
                            <p className="text-xs font-medium text-text">{c.title}</p>
                            <ul className="mt-1.5 space-y-1">
                              {c.versions.map((v, j) => (
                                <li key={j} className="flex gap-2 text-xs leading-relaxed text-text-2">
                                  <span className="shrink-0 rounded bg-surface-2 px-1 text-[9px] text-text-4">
                                    版本{j + 1}
                                  </span>
                                  <span>
                                    {v.text}
                                    <Cite refs={v.refs} sources={sources} />
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </Section>
                  ) : null}
                  {dossier.risks.length ? (
                    <Section title="风险与待核实">
                      <ul className="space-y-1.5">
                        {dossier.risks.map((r, i) => (
                          <li key={i} className="flex gap-2 text-xs leading-relaxed text-text-2">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warn" />
                            <span>
                              {r.text}
                              <Cite refs={r.refs} sources={sources} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null}
                  {dossier.materialClusters.length ? (
                    <Section title="材料簇（可入片的细节/场景/引语）">
                      <div className="grid grid-cols-2 gap-3">
                        {dossier.materialClusters.map((m, i) => (
                          <div key={i} className="rounded-lg border border-hairline p-3">
                            <p className="text-xs font-medium text-text">{m.title}</p>
                            <ul className="mt-1.5 space-y-1">
                              {m.points.map((p, j) => (
                                <li key={j} className="text-xs leading-relaxed text-text-2">
                                  {p.text}
                                  <Cite refs={p.refs} sources={sources} />
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </Section>
                  ) : null}
                </>
              ) : (
                <p className="mt-8 text-center text-xs text-text-4">
                  {job.status === "running"
                    ? "卷宗撰写中，完成后自动出现"
                    : job.error || "暂无卷宗"}
                </p>
              )}
            </>
          ) : tab === "sources" ? (
            <ul className="space-y-2">
              {sources.map((s) => (
                <li key={s.sid} className="rounded-lg border border-hairline p-2.5">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 rounded border border-hairline bg-surface-2 px-1 text-[9px] font-medium tabular-nums text-text-3">
                      {s.sid}
                    </span>
                    <div className="min-w-0 flex-1">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="line-clamp-1 text-xs text-text hover:text-accent hover:underline"
                      >
                        {s.title}
                      </a>
                      <p className="mt-0.5 text-[10px] text-text-4">
                        {s.category}
                        {s.fetchStatus === "snippet" ? " · 摘要级（原文未抓到）" : ""}
                        {s.domain ? ` · ${s.domain}` : ""}
                        {s.round === 99 ? " · 补研" : ` · 第 ${s.round} 轮`}
                        {s.query ? ` · 「${s.query}」` : ""}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
              {!sources.length ? (
                <p className="mt-8 text-center text-xs text-text-4">还没有来源</p>
              ) : null}
            </ul>
          ) : (
            <ol className="space-y-1.5">
              {job.log.map((l, i) => (
                <li key={i} className="flex gap-2 text-xs">
                  <span className="shrink-0 tabular-nums text-text-4">
                    {l.t.slice(11, 19)}
                  </span>
                  <span
                    className={
                      l.kind === "error"
                        ? "text-danger"
                        : l.kind === "dossier" || l.kind === "plan"
                          ? "font-medium text-text"
                          : "text-text-2"
                    }
                  >
                    {l.text}
                  </span>
                </li>
              ))}
              {!job.log.length ? (
                <p className="mt-8 text-center text-xs text-text-4">暂无过程记录</p>
              ) : null}
            </ol>
          )}
        </div>

        {/* 底部：补研输入 */}
        {job && job.status !== "planning" ? (
          <div className="border-t border-hairline px-5 py-2.5">
            {gapJobId ? (
              <p className="flex items-center gap-2 text-xs text-text-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                补研执行中（定点追加，不重跑全查）……完成后卷宗自动更新
              </p>
            ) : (
              <div className="flex gap-2">
                <textarea
                  value={gapInput}
                  onChange={(e) => setGapInput(e.target.value)}
                  placeholder={"补充调研：每行一个具体问题，定点追加证据后重写卷宗\n例：官渡之战曹军兵力的学术争议有哪些"}
                  rows={2}
                  maxLength={500}
                  className="min-h-0 flex-1 resize-none rounded-md border border-hairline bg-surface-2/60 px-2 py-1.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
                />
                <button
                  type="button"
                  disabled={!gapInput.trim()}
                  className="flex shrink-0 items-center gap-1 self-end rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
                  onClick={() => void startGap()}
                >
                  <Plus className="h-3.5 w-3.5" />
                  补研
                </button>
              </div>
            )}
            {gapErr ? <p className="mt-1 text-[10px] text-danger">{gapErr}</p> : null}
          </div>
        ) : null}
      </div>
    </OverlayModal>
  );
}
