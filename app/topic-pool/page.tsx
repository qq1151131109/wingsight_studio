"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ExternalLink,
  Eye,
  Film,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import AuthGate from "@/components/shell/AuthGate";
import {
  adoptTopic,
  dismissTopic,
  getRescanJob,
  getSchedule,
  listTopics,
  refreshTopics,
  setSchedule,
  startRescan,
  type AutoRefreshSchedule,
  type Topic,
  type TopicRefreshRun,
  type TopicVertical,
} from "@/lib/topics";

/**
 * 选题池 · 生产前漏斗（跨项目全局，信息架构照搬 juben TopicPoolPage）。
 * 刷新 = 后台策展管线（材料窗口采集 → LLM 研判 → 迭代取证 → 两级结论），
 * 前端轮询 refreshing 字段；认领 = 建项目 + 选题落画布剧本卡。
 */

type StatusTab = "candidate" | "adopted" | "dismissed";

const VERTICAL_LABEL: Record<TopicVertical, string> = { history: "历史", crime: "罪案" };
const VERTICAL_DOT: Record<TopicVertical, string> = {
  history: "var(--color-cool)",
  crime: "var(--color-danger)",
};
const SOURCE_LABEL: Record<string, string> = {
  material: "材料窗口",
  anniversary: "周年节点",
  commission: "委托调研",
  entity: "富矿库",
};

function isStrong(t: Topic): boolean {
  return t.research.evidence_level === "strong";
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = 60_000;
  if (diff < min) return "刚刚";
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`;
  return d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function lastRunSummary(run: TopicRefreshRun): string {
  if (!run?.finishedAt) return "";
  const parts: string[] = [];
  if (typeof run.collected === "number") parts.push(`采集 ${run.collected}`);
  if (typeof run.shortlisted === "number") parts.push(`入围 ${run.shortlisted}`);
  const produced = (run.created ?? 0) + (run.observed ?? 0);
  if (produced || run.upgraded) parts.push(`建议 +${run.created ?? 0} · 观察 +${run.observed ?? 0}${run.upgraded ? ` · 升级 ${run.upgraded}` : ""}`);
  if (run.rescanned) parts.push(`复查 ${run.rescanned}${run.rescanUpgraded ? `（升级 ${run.rescanUpgraded}）` : ""}`);
  const prefix = run.error ? `上次刷新中断（${run.error}）` : `上次刷新：${parts.join(" · ") || "无产出"}`;
  return `${prefix} · ${formatTime(run.finishedAt)}`;
}

function TopicPoolInner() {
  const router = useRouter();
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRun, setLastRun] = useState<TopicRefreshRun>({});
  const [statusTab, setStatusTab] = useState<StatusTab>("candidate");
  const [vertical, setVertical] = useState<TopicVertical | "all">("all");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"danger" | "good">("danger");
  const [schedule, setScheduleState] = useState<AutoRefreshSchedule | null>(null);
  const [rescanJob, setRescanJob] = useState<{ jobId: string; topicId: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  const notify = (msg: string, tone: "danger" | "good" = "danger") => {
    setNotice(msg);
    setNoticeTone(tone);
  };

  const load = useCallback(
    async (opts?: { keepSelection?: boolean }) => {
      try {
        const data = await listTopics({
          status: statusTab,
          vertical: vertical === "all" ? undefined : vertical,
          q,
        });
        setTopics(data.topics);
        setRefreshing(data.refreshing);
        setLastRun(data.lastRun);
        setSelectedId((prev) =>
          opts?.keepSelection === true && prev && data.topics.some((t) => t.id === prev)
            ? prev
            : (data.topics[0]?.id ?? null),
        );
      } catch {
        notify("选题池加载失败（服务未连接？）");
        setTopics([]);
      }
    },
    [statusTab, vertical, q],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await listTopics({
          status: statusTab,
          vertical: vertical === "all" ? undefined : vertical,
          q,
        });
        if (!alive) return;
        setTopics(data.topics);
        setRefreshing(data.refreshing);
        setLastRun(data.lastRun);
        setSelectedId(data.topics[0]?.id ?? null);
      } catch {
        if (alive) {
          notify("选题池加载失败（服务未连接？）");
          setTopics([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [statusTab, vertical, q]);

  // 刷新期间轮询（3s），完成后重拉一次拿到产出统计
  useEffect(() => {
    if (!refreshing) return;
    pollRef.current = window.setInterval(() => void load({ keepSelection: true }), 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [refreshing, load]);

  // 每日自动刷新设置（读不到不影响主功能，顶栏控件不渲染）
  useEffect(() => {
    let alive = true;
    getSchedule()
      .then((d) => {
        if (alive) setScheduleState(d.schedule);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const updateSchedule = async (patch: Partial<AutoRefreshSchedule>) => {
    if (!schedule) return;
    const next = { ...schedule, ...patch };
    setScheduleState(next); // 乐观更新，失败回读
    try {
      setScheduleState(await setSchedule(next));
    } catch (e) {
      notify(e instanceof Error ? e.message : "自动刷新设置保存失败");
      getSchedule()
        .then((d) => setScheduleState(d.schedule))
        .catch(() => {});
    }
  };

  // 深挖任务轮询（2.5s），完成/失败即停并刷新该卡
  useEffect(() => {
    if (!rescanJob) return;
    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const job = await getRescanJob(rescanJob.jobId);
        if (!alive || job.status === "running") return;
        setRescanJob(null);
        void load({ keepSelection: true });
        if (job.status === "error") notify(`深挖失败：${job.error || "未知错误"}`);
        else if (job.outcome === "upgraded") notify("复查完成：证据变硬，已升级为建议卡", "good");
        else if (job.outcome === "thin") notify("复查完成：证据仍薄，新取证已记入信源底账");
        else notify("复查完成：本轮未得出新结论，已记一次复查");
      } catch {
        // 轮询单次失败下一跳再试
      }
    }, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [rescanJob, load]);

  const doRescan = async (t: Topic) => {
    setNotice("");
    try {
      const jobId = await startRescan(t.id);
      setRescanJob({ jobId, topicId: t.id });
    } catch (e) {
      notify(e instanceof Error ? e.message : "启动深挖失败");
    }
  };

  const startRefresh = async () => {
    notify("");
    const r = await refreshTopics();
    if (r === "conflict") {
      notify("已有刷新在跑");
      return;
    }
    if (r === "unconfigured") {
      notify("选题 flow 未配置（LANGFLOW_TOPIC_*_FLOW_ID）");
      return;
    }
    setRefreshing(true);
  };

  const doDismiss = async (t: Topic) => {
    if (!window.confirm(`忽略「${t.title}」？忽略后本轮策展不再打扰。`)) return;
    setBusyId(t.id);
    if (await dismissTopic(t.id)) void load({ keepSelection: true });
    else notify("忽略失败");
    setBusyId(null);
  };

  const doAdopt = async (t: Topic) => {
    setBusyId(t.id);
    notify("");
    const r = await adoptTopic(t.id);
    setBusyId(null);
    if (!r) {
      notify("认领失败（可能已被认领）");
      return;
    }
    router.push(`/project/${r.pid}`);
  };

  const selected = topics?.find((t) => t.id === selectedId) ?? null;
  const strong = (topics ?? []).filter(isStrong);
  const thin = (topics ?? []).filter((t) => !isStrong(t));

  return (
    <div className="flex h-dvh flex-col bg-bg">
      {/* 顶栏 */}
      <header className="border-b border-hairline bg-bg/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 py-3.5">
          <Link
            href="/"
            className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            项目
          </Link>
          <div className="mr-auto">
            <h1 className="font-editorial text-base font-semibold leading-tight text-text">选题池</h1>
            <p className="text-[11px] leading-tight text-text-3">
              {refreshing ? "策展刷新进行中：采集信号 → 研判 → 取证 → 结论…" : "跨项目的候选选题库，认领即立项"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void startRefresh()}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "motion-safe:animate-spin" : ""}`} />
            刷新选题
          </button>
          {schedule ? (
            <label className="flex items-center gap-2 rounded-md border border-hairline bg-surface-1 px-2.5 py-1.5 text-xs text-text-2">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(e) => void updateSchedule({ enabled: e.target.checked })}
                style={{ accentColor: "var(--color-accent)" }}
                className="h-3.5 w-3.5 cursor-pointer"
              />
              每日自动
              <input
                type="time"
                value={schedule.time}
                disabled={!schedule.enabled}
                onChange={(e) => void updateSchedule({ time: e.target.value })}
                className={`rounded border border-hairline-soft bg-surface-2/60 px-1 py-0.5 text-[11px] text-text outline-none ${schedule.enabled ? "" : "opacity-50"}`}
              />
            </label>
          ) : null}
        </div>
        <div className="mx-auto w-full max-w-6xl px-6 pb-2">
          <p className="text-[11px] text-text-4">
            {refreshing ? "正在跑完整管线（多次检索与研判，需几分钟）…" : lastRunSummary(lastRun)}
          </p>
        </div>
      </header>

      {/* 筛选行 */}
      <div className="border-b border-hairline-soft bg-surface-2/60">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-6 py-2">
          <div className="flex rounded-md border border-hairline bg-surface-1 p-0.5">
            {(["candidate", "adopted", "dismissed"] as StatusTab[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusTab(s)}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  statusTab === s ? "bg-accent text-white" : "text-text-3 hover:text-text"
                }`}
              >
                {s === "candidate" ? "待立项" : s === "adopted" ? "已认领" : "已忽略"}
              </button>
            ))}
          </div>
          <div className="flex rounded-md border border-hairline bg-surface-1 p-0.5">
            {(["all", "history", "crime"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVertical(v)}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  vertical === v ? "bg-surface-2 text-text shadow-sm" : "text-text-3 hover:text-text"
                }`}
              >
                {v === "all" ? "全部垂类" : VERTICAL_LABEL[v]}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-56">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索选题…"
              className="w-full rounded-md border border-hairline bg-surface-1 py-1.5 pl-8 pr-3 text-xs text-text outline-none focus:border-accent"
            />
          </div>
        </div>
      </div>

      {notice ? (
        <p
          className={`mx-auto mt-3 w-full max-w-6xl rounded-md px-3 py-2 text-xs ${
            noticeTone === "good" ? "bg-good/10 text-good" : "bg-danger/10 text-danger"
          }`}
        >
          {notice}
        </p>
      ) : null}

      {/* 主体：左列表 + 右详情 */}
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 overflow-hidden px-6 py-4 lg:grid-cols-[380px_1fr]">
        <section className="min-h-0 space-y-4 overflow-y-auto pb-4 pr-1">
          {topics === null ? (
            <div className="flex items-center gap-2 px-1 py-8 text-xs text-text-3">
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
              加载选题池…
            </div>
          ) : topics.length === 0 ? (
            <div className="rounded-xl border border-dashed border-hairline bg-surface-1/60 px-4 py-10 text-center">
              <Film className="mx-auto mb-2 h-6 w-6 text-text-4" />
              <p className="text-xs text-text-3">
                {statusTab === "candidate" ? "池子空了。点右上角「刷新选题」跑一轮策展。" : "这里还没有选题。"}
              </p>
            </div>
          ) : (
            <>
              {statusTab === "candidate" && strong.length > 0 ? (
                <TopicSection title={`可立项建议（${strong.length}）`}>
                  {strong.map((t) => (
                    <TopicCard
                      key={t.id}
                      topic={t}
                      selected={t.id === selectedId}
                      busy={busyId === t.id}
                      onSelect={() => setSelectedId(t.id)}
                    />
                  ))}
                </TopicSection>
              ) : null}
              {statusTab === "candidate" && thin.length > 0 ? (
                <TopicSection title={`观察中（${thin.length}）`}>
                  {thin.map((t) => (
                    <TopicCard
                      key={t.id}
                      topic={t}
                      selected={t.id === selectedId}
                      busy={busyId === t.id}
                      onSelect={() => setSelectedId(t.id)}
                    />
                  ))}
                </TopicSection>
              ) : null}
              {statusTab !== "candidate"
                ? topics.map((t) => (
                    <TopicCard
                      key={t.id}
                      topic={t}
                      selected={t.id === selectedId}
                      busy={busyId === t.id}
                      onSelect={() => setSelectedId(t.id)}
                    />
                  ))
                : null}
            </>
          )}
        </section>

        <section className="min-h-0 overflow-y-auto pb-4">
          {selected ? (
            <TopicDetail
              topic={selected}
              busy={busyId === selected.id}
              rescanBusy={rescanJob?.topicId === selected.id}
              onAdopt={() => void doAdopt(selected)}
              onDismiss={() => void doDismiss(selected)}
              onRescan={() => void doRescan(selected)}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function TopicSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-text-4">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function TopicCard({
  topic,
  selected,
  busy,
  onSelect,
}: {
  topic: Topic;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`ws-card block w-full cursor-pointer p-3 text-left transition-shadow ${
        selected ? "ring-1 ring-accent" : "hover:shadow-md"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: VERTICAL_DOT[topic.vertical] }} />
        <span className="text-[10px] text-text-4">{VERTICAL_LABEL[topic.vertical]}</span>
        <span className="text-[10px] text-text-4">· {SOURCE_LABEL[topic.source] ?? topic.source}</span>
        {busy ? <Loader2 className="ml-auto h-3 w-3 text-text-4 motion-safe:animate-spin" /> : null}
      </div>
      <h3 className="font-editorial mt-1 line-clamp-2 text-sm font-semibold text-text">
        {isStrong(topic) ? topic.title : topic.research.event || topic.title}
      </h3>
      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-3">
        {topic.summary || topic.research.observation}
      </p>
      {isStrong(topic) && topic.angles.length > 0 ? (
        <p className="mt-1.5 line-clamp-1 text-[11px] text-text-4">角度：{topic.angles.join(" / ")}</p>
      ) : null}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-0.5 text-[11px] font-medium text-text-4">{label}</h4>
      <div className="text-xs leading-relaxed text-text-2">{children}</div>
    </div>
  );
}

const UNIT_KIND_LABEL: Record<string, string> = {
  person: "人物",
  object: "物",
  case: "案件",
  era: "年代",
};
const SCALE_LABEL: Record<string, string> = {
  single: "单片",
  series: "系列",
  anthology: "选集",
};

function TopicDetail({
  topic,
  busy,
  rescanBusy,
  onAdopt,
  onDismiss,
  onRescan,
}: {
  topic: Topic;
  busy: boolean;
  rescanBusy: boolean;
  onAdopt: () => void;
  onDismiss: () => void;
  onRescan: () => void;
}) {
  const r = topic.research;
  const strong = isStrong(topic);
  const rescanNote =
    topic.status === "candidate" && !strong
      ? topic.lastRescanAt
        ? `上次复查 ${formatTime(topic.lastRescanAt)}`
        : "尚未复查"
      : "";
  return (
    <div className="ws-card p-5">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: VERTICAL_DOT[topic.vertical] }} />
        <span className="text-[11px] text-text-4">
          {VERTICAL_LABEL[topic.vertical]} · {SOURCE_LABEL[topic.source] ?? topic.source} · 收录于{" "}
          {formatTime(topic.createdAt)}
          {rescanNote ? ` · ${rescanNote}` : ""}
        </span>
      </div>
      <h2 className="font-editorial mt-1 text-lg font-semibold leading-snug text-text">
        {strong ? topic.title : "观察：" + (r.event || topic.title)}
      </h2>
      {topic.summary ? <p className="mt-2 text-xs leading-relaxed text-text-2">{topic.summary}</p> : null}

      <div className="mt-4 space-y-3.5">
        {r.emotion ? (
          <div className="rounded-lg border border-hairline-soft bg-surface-2/70 p-3">
            <h4 className="text-[11px] font-medium text-text-4">情绪钩子</h4>
            <p className="font-editorial mt-0.5 text-sm text-text">{r.emotion}</p>
          </div>
        ) : null}
        {strong ? (
          <>
            {r.event ? <Field label="已核实事件">{r.event}</Field> : null}
            {r.why_now ? <Field label="为何是现在">{r.why_now}</Field> : null}
            {r.person_anchor ? <Field label="人物锚点（跟拍谁）">{r.person_anchor}</Field> : null}
            {topic.angles.length > 0 ? (
              <Field label="讲法角度">
                <ul className="list-inside list-disc space-y-0.5">
                  {topic.angles.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Field>
            ) : null}
            {r.material_base ? <Field label="材料底数">{r.material_base}</Field> : null}
            {r.competition_gap ? <Field label="对家与差异">{r.competition_gap}</Field> : null}
            <div className="flex flex-wrap gap-2">
              {r.unit_kind ? (
                <span className="rounded-full bg-warm-soft px-2.5 py-1 text-[11px] text-text-2">
                  可拍单元：{UNIT_KIND_LABEL[r.unit_kind] ?? r.unit_kind}
                </span>
              ) : null}
              {r.scale ? (
                <span className="rounded-full bg-warm-soft px-2.5 py-1 text-[11px] text-text-2">
                  体量：{SCALE_LABEL[r.scale] ?? r.scale}
                  {r.scale === "series" && r.series_thread ? ` · 串珠问题：${r.series_thread}` : ""}
                </span>
              ) : null}
            </div>
            {r.viewing_question ? (
              <div className="rounded-lg border border-hairline-soft bg-surface-2/70 p-3">
                <h4 className="text-[11px] font-medium text-text-4">观看问题</h4>
                <p className="font-editorial mt-0.5 text-sm text-text">{r.viewing_question}</p>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {r.event ? <Field label="已核实事实">{r.event}</Field> : null}
            {r.gaps && r.gaps.length > 0 ? (
              <Field label="立项缺口">
                <ul className="list-inside list-disc space-y-0.5">
                  {r.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </Field>
            ) : null}
            {r.observation ? <Field label="观察记录">{r.observation}</Field> : null}
          </>
        )}

        {topic.heatEvidence.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-[11px] font-medium text-text-4 hover:text-text-3">
              信号依据（{topic.heatEvidence.length} 条）
            </summary>
            <ul className="mt-1.5 space-y-1">
              {topic.heatEvidence.map((h, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-text-3">
                  {h.url ? (
                    <a href={h.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      {h.title} <ExternalLink className="inline h-3 w-3" />
                    </a>
                  ) : (
                    h.title
                  )}
                  <span className="text-text-4"> — {h.source}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {r.source_map && r.source_map.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-[11px] font-medium text-text-4 hover:text-text-3">
              信源底账（{r.source_map.length} 轮检索）
            </summary>
            <div className="mt-1.5 space-y-2">
              {r.source_map.map((entry, i) => (
                <div key={i} className="rounded-lg border border-hairline-soft bg-surface-2/50 p-2.5">
                  <p className="text-[11px] text-text-3">
                    【{entry.label}】{entry.query}
                  </p>
                  {entry.results.length === 0 ? (
                    <p className="mt-1 text-[11px] text-text-4">（未检索到）</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5">
                      {entry.results.map((res, j) => (
                        <li key={j} className="text-[11px] leading-relaxed text-text-3">
                          {res.url ? (
                            <a href={res.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                              {res.title}
                            </a>
                          ) : (
                            res.title
                          )}
                          {res.snippet ? <span className="text-text-4"> — {res.snippet}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      {topic.status === "candidate" ? (
        <div className="mt-5 flex items-center gap-2 border-t border-hairline-soft pt-4">
          <button
            type="button"
            onClick={onAdopt}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            认领立项
          </button>
          {!strong ? (
            <button
              type="button"
              onClick={onRescan}
              disabled={busy || rescanBusy}
              className="flex items-center gap-1.5 rounded-md border border-hairline px-3.5 py-2 text-xs text-text-2 transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              {rescanBusy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
              深挖一下
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md border border-hairline px-3.5 py-2 text-xs text-text-2 transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            忽略
          </button>
          <span className="ml-auto flex items-center gap-1 text-[11px] text-text-4">
            {strong ? <BookOpen className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {strong ? "证据充分 · 可立项" : "证据不足 · 继续观察"}
          </span>
        </div>
      ) : null}
      {topic.status === "adopted" ? (
        <p className="mt-5 border-t border-hairline-soft pt-4 text-xs text-good">已认领立项</p>
      ) : null}
      {topic.status === "dismissed" ? (
        <p className="mt-5 border-t border-hairline-soft pt-4 text-xs text-text-4">已忽略</p>
      ) : null}
    </div>
  );
}

export default function TopicPoolPage() {
  return (
    <AuthGate>
      <TopicPoolInner />
    </AuthGate>
  );
}
