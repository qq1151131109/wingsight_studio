"use client";

/**
 * 标杆拆解知识库面板：把「近期热内容为什么被接受」的结构化拆解摊开给用户看。
 *
 * 知识由刷新管线每日从平台/豆瓣热内容采样拆解（topic-teardown flow）后落库，
 * 收敛时注入提示词影响选题。本面板 = 可见性 + 可修订：用户改过的条目打
 * edited 标记，后续重拆不再覆盖（后端 insights.update_insight 保证）。
 * 入口在选题池顶栏「标杆拆解」按钮，OverlayModal portal（z 档位表 1300）。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import OverlayModal from "@/components/canvas/OverlayModal";
import {
  deleteInsight,
  listInsights,
  updateInsight,
  type TopicInsight,
} from "@/lib/topics";

const FIELDS: { key: keyof EditDraft; label: string; hint: string }[] = [
  { key: "subject", label: "题材", hint: "这是什么内容（题材类型+具体对象）" },
  { key: "treatment", label: "讲法", hint: "怎么讲的（叙述装置/结构形态）" },
  { key: "emotion", label: "情绪入口", hint: "观众为什么点进来" },
  { key: "form", label: "形式", hint: "时长/节奏/视角/单元结构" },
];

type EditDraft = Pick<
  TopicInsight,
  "subject" | "treatment" | "emotion" | "form" | "transferable" | "evidence"
>;

function draftOf(t: TopicInsight): EditDraft {
  return {
    subject: t.subject,
    treatment: t.treatment,
    emotion: t.emotion,
    form: t.form,
    transferable: t.transferable,
    evidence: t.evidence,
  };
}

export default function InsightsDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<TopicInsight[]>([]);
  const [statsLine, setStatsLine] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [busy, setBusy] = useState(false);

  // 挂载即拉（父组件条件渲染本组件）；首帧 await 在前，不在 effect 里同步 setState
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await listInsights();
        if (!alive) return;
        setItems(data.insights ?? []);
        setStatsLine(data.statsLine ?? "");
        setFailed("");
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : "读取失败");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  const save = useCallback(async (id: string) => {
    if (!draft) return;
    setBusy(true);
    try {
      if (await updateInsight(id, draft)) {
        setEditing(null);
        setDraft(null);
        reload();
      } else {
        setFailed("保存失败");
      }
    } finally {
      setBusy(false);
    }
  }, [draft, reload]);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await deleteInsight(id);
      reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6 ws-scrim-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden ws-dialog-in ws-elev-modal rounded-xl bg-bg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-5 py-3.5">
          <div className="mr-auto">
            <h2 className="font-editorial text-sm font-semibold text-text">标杆拆解知识库</h2>
            <p className="mt-0.5 text-[11px] text-text-3">
              {statsLine || "每日从平台/豆瓣热内容采样拆解，选题生成时自动参考"}
            </p>
          </div>
          <span className="text-[11px] text-text-3">{items.length} 条</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-xs text-text-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 读取中…
            </div>
          ) : failed ? (
            <p className="py-8 text-center text-xs text-danger">{failed}</p>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-xs text-text-3">
              还没有拆解知识。跑一轮「刷新选题」，管线会自动从热榜/豆瓣采样拆解。
            </p>
          ) : (
            <ul className="space-y-3">
              {items.map((it) => {
                const isEditing = editing === it.id;
                return (
                  <li key={it.id} className="ws-card ws-no-enter p-3">
                    <div className="flex items-baseline gap-2">
                      {it.url ? (
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-[13px] font-medium text-text hover:underline"
                        >
                          {it.title}
                        </a>
                      ) : (
                        <span className="truncate text-[13px] font-medium text-text">{it.title}</span>
                      )}
                      {it.platform ? (
                        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-3">
                          {it.platform}
                        </span>
                      ) : null}
                      {it.edited ? (
                        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-3">
                          已修订
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 text-[10px] text-text-3">
                        引用 {it.useCount} 次
                      </span>
                    </div>
                    {it.metric ? (
                      <p className="mt-1 text-[11px] text-text-3">{it.metric}</p>
                    ) : null}

                    {isEditing && draft ? (
                      <div className="mt-2 space-y-2">
                        {FIELDS.map((f) => (
                          <label key={f.key} className="block">
                            <span className="text-[11px] text-text-3">{f.label}</span>
                            <input
                              value={draft[f.key]}
                              placeholder={f.hint}
                              onChange={(e) =>
                                setDraft({ ...draft, [f.key]: e.target.value })
                              }
                              className="mt-0.5 w-full rounded-md border border-hairline bg-surface-1 px-2 py-1 text-xs text-text outline-none focus:border-accent"
                            />
                          </label>
                        ))}
                        <label className="block">
                          <span className="text-[11px] text-text-3">可迁移结论（选题生成直接参考）</span>
                          <textarea
                            value={draft.transferable}
                            rows={2}
                            onChange={(e) => setDraft({ ...draft, transferable: e.target.value })}
                            className="mt-0.5 w-full resize-y rounded-md border border-hairline bg-surface-1 px-2 py-1 text-xs text-text outline-none focus:border-accent"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[11px] text-text-3">证据</span>
                          <input
                            value={draft.evidence}
                            onChange={(e) => setDraft({ ...draft, evidence: e.target.value })}
                            className="mt-0.5 w-full rounded-md border border-hairline bg-surface-1 px-2 py-1 text-xs text-text outline-none focus:border-accent"
                          />
                        </label>
                        <div className="flex items-center gap-2 pt-0.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void save(it.id)}
                            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(null);
                              setDraft(null);
                            }}
                            className="rounded-md border border-hairline px-2.5 py-1 text-[11px] text-text-2 hover:bg-surface-2"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void remove(it.id)}
                            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-3 transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" /> 删除
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
                          {FIELDS.map((f) =>
                            it[f.key] ? (
                              <div key={f.key} className="contents">
                                <dt className="text-text-3">{f.label}</dt>
                                <dd className="text-text-2">{it[f.key]}</dd>
                              </div>
                            ) : null,
                          )}
                        </dl>
                        {it.transferable ? (
                          <p className="mt-2 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] leading-relaxed text-text-2">
                            <span className="text-text-3">可迁移 · </span>
                            {it.transferable}
                          </p>
                        ) : null}
                        <div className="mt-2 flex items-center gap-2">
                          {it.evidence ? (
                            <span className="mr-auto truncate text-[10px] text-text-3">
                              证据：{it.evidence}
                            </span>
                          ) : (
                            <span className="mr-auto" />
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(it.id);
                              setDraft(draftOf(it));
                            }}
                            className="rounded-md border border-hairline px-2 py-0.5 text-[11px] text-text-2 transition-colors hover:bg-surface-2"
                          >
                            修订
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </OverlayModal>
  );
}
