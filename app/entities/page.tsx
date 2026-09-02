"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Film, Loader2, Search } from "lucide-react";
import AuthGate from "@/components/shell/AuthGate";
import {
  ENTITY_KIND_COLOR,
  ENTITY_KIND_LABEL,
  getEntity,
  listEntities,
  type EntityItem,
  type EntityKind,
} from "@/lib/entities";
import type { Topic } from "@/lib/topics";

/**
 * 实体库 · 跨选题知识节点（实体图谱地基）。
 * 实体只从选题管线证据里长出来：verdict 抽取 → 归一登记 → 与选题卡双向关联。
 * 页面 = 浏览/搜索 + 详情（已核实事实、信源底账、关联选题）。
 */

const KIND_FILTERS: { value: EntityKind | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "person", label: "人物" },
  { value: "object", label: "物" },
  { value: "case", label: "案件" },
  { value: "era", label: "年代" },
  { value: "place", label: "地点" },
];

const TOPIC_STATUS_LABEL: Record<string, string> = {
  candidate: "待立项",
  adopted: "已认领",
  dismissed: "已忽略",
  archived: "已归档",
};

function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function EntitiesInner() {
  const [entities, setEntities] = useState<EntityItem[] | null>(null);
  const [kind, setKind] = useState<EntityKind | "all">("all");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ entity: EntityItem; topics: Topic[] } | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await listEntities({ kind: kind === "all" ? undefined : kind, q });
      setEntities(list);
      setSelectedId((prev) => (prev && list.some((e) => e.id === prev) ? prev : (list[0]?.id ?? null)));
      setNotice("");
    } catch {
      setNotice("实体库加载失败（服务未连接？）");
      setEntities([]);
    }
  }, [kind, q]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    void (async () => {
      try {
        const d = await getEntity(selectedId);
        if (alive) setDetail(d);
      } catch {
        /* 单次详情拉取失败静默，下次选择重试 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const select = (id: string) => {
    setDetail(null); // 切换时先清旧详情，防串卡闪显
    setSelectedId(id);
  };

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="border-b border-hairline bg-bg/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 py-3.5">
          <Link
            href="/topic-pool"
            className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            选题池
          </Link>
          <div className="mr-auto">
            <h1 className="font-editorial text-base font-semibold leading-tight text-text">实体库</h1>
            <p className="text-[11px] leading-tight text-text-3">
              从选题证据中沉淀的人/物/案件/年代/地点——跨选题的知识底座
            </p>
          </div>
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索实体…"
              className="w-full rounded-md border border-hairline bg-surface-1 py-1.5 pl-8 pr-3 text-xs text-text outline-none focus:border-accent"
            />
          </div>
        </div>
        <div className="mx-auto w-full max-w-6xl px-6 pb-2">
          <div className="flex flex-wrap gap-1.5">
            {KIND_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setKind(f.value)}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  kind === f.value ? "bg-surface-2 text-text shadow-sm" : "text-text-3 hover:text-text"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {notice ? (
        <p className="mx-auto mt-3 w-full max-w-6xl rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{notice}</p>
      ) : null}

      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 overflow-hidden px-6 py-4 lg:grid-cols-[380px_1fr]">
        <section className="min-h-0 space-y-2 overflow-y-auto pb-4 pr-1">
          {entities === null ? (
            <div className="flex items-center gap-2 px-1 py-8 text-xs text-text-3">
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
              加载实体库…
            </div>
          ) : entities.length === 0 ? (
            <div className="rounded-xl border border-dashed border-hairline bg-surface-1/60 px-4 py-10 text-center">
              <Film className="mx-auto mb-2 h-6 w-6 text-text-4" />
              <p className="text-xs text-text-3">还没有实体。跑一轮选题刷新，实体就会从证据里长出来。</p>
            </div>
          ) : (
            entities.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => select(e.id)}
                className={`ws-card block w-full cursor-pointer p-3 text-left transition-shadow ${
                  selectedId === e.id ? "ring-1 ring-accent" : "hover:shadow-md"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: ENTITY_KIND_COLOR[e.kind] ?? "var(--color-text-4)" }}
                  />
                  <span className="text-[10px] text-text-4">{ENTITY_KIND_LABEL[e.kind] ?? e.kind}</span>
                  <span className="text-[10px] text-text-4">· 关联 {e.topicCount ?? 0} 个选题</span>
                </div>
                <h3 className="font-editorial mt-1 text-sm font-semibold text-text">{e.name}</h3>
                {e.summary ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-3">{e.summary}</p>
                ) : null}
              </button>
            ))
          )}
        </section>

        <section className="min-h-0 overflow-y-auto pb-4">
          {detail ? (
            <div className="ws-card p-5">
              <div className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: ENTITY_KIND_COLOR[detail.entity.kind] ?? "var(--color-text-4)" }}
                />
                <span className="text-[11px] text-text-4">
                  {ENTITY_KIND_LABEL[detail.entity.kind] ?? detail.entity.kind} · 最近出现{" "}
                  {formatTime(detail.entity.lastSeenAt)}
                </span>
              </div>
              <h2 className="font-editorial mt-1 text-lg font-semibold leading-snug text-text">
                {detail.entity.name}
              </h2>
              {detail.entity.aliases.length > 0 ? (
                <p className="mt-1 text-[11px] text-text-4">别名：{detail.entity.aliases.join("、")}</p>
              ) : null}
              {detail.entity.summary ? (
                <p className="mt-2 text-xs leading-relaxed text-text-2">{detail.entity.summary}</p>
              ) : null}

              {detail.entity.evidence.length > 0 ? (
                <details className="mt-4" open>
                  <summary className="cursor-pointer text-[11px] font-medium text-text-4 hover:text-text-3">
                    信源底账（{detail.entity.evidence.length} 条）
                  </summary>
                  <ul className="mt-1.5 space-y-1">
                    {detail.entity.evidence.map((ev, i) => (
                      <li key={i} className="text-[11px] leading-relaxed text-text-3">
                        {ev.url ? (
                          <a href={ev.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                            {ev.title || ev.url} <ExternalLink className="inline h-3 w-3" />
                          </a>
                        ) : (
                          ev.title
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div className="mt-4 border-t border-hairline-soft pt-3">
                <h4 className="text-[11px] font-medium text-text-4">关联选题（{detail.topics.length}）</h4>
                {detail.topics.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-text-4">暂无</p>
                ) : (
                  <ul className="mt-1.5 space-y-1.5">
                    {detail.topics.map((t) => (
                      <li key={t.id} className="text-xs leading-relaxed text-text-2">
                        <span className="text-[10px] text-text-4">[{TOPIC_STATUS_LABEL[t.status] ?? t.status}]</span>{" "}
                        {t.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

export default function EntitiesPage() {
  return (
    <AuthGate>
      <EntitiesInner />
    </AuthGate>
  );
}
