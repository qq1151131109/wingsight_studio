"use client";

/**
 * 助手能力面板（发现性入口）：聊天 header「能力」按钮或 OPEN_CAPABILITIES_EVENT
 * 呼出，OverlayModal portal（画布内裸 fixed 会被 viewport transform 劫持）。
 * 三分区（数据来自 GET /agent-service/capabilities，打开时现拉）：
 *   能做什么 —— 用户语言能力卡，点示例句插入输入条（CHAT_INSERT_TEXT_EVENT）
 *   生成技能 —— Langflow 注册表（输入条打 / 同源），点击插入调用模板
 *   方法手册 —— agent/skills 的 SKILL.md，展开看全文（助手执行对应任务时读它）
 */

import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, Sparkles, Wand2, X } from "lucide-react";
import OverlayModal from "@/components/canvas/OverlayModal";
import { apiFetch } from "@/lib/auth";
import {
  CHAT_INSERT_TEXT_EVENT,
  OPEN_CAPABILITIES_EVENT,
} from "@/lib/canvas/events";

type Action = { title: string; desc: string; example: string };
type Flow = { name: string; description?: string; params?: { name: string; desc?: string }[] };
type Manual = { name: string; description: string; body: string };

const insertToChat = (text: string) => {
  window.dispatchEvent(
    new CustomEvent(CHAT_INSERT_TEXT_EVENT, { detail: { text } }),
  );
};

export default function CapabilitiesDialog() {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<Action[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [manuals, setManuals] = useState<Manual[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setFailed(false);
      setOpen(true);
    };
    window.addEventListener(OPEN_CAPABILITIES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CAPABILITIES_EVENT, onOpen);
  }, []);

  // 打开时现拉（不挂载拉：清单低频看，且 agent 重启后手册即时更新）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      try {
        const r = await apiFetch("/agent-service/capabilities");
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as {
          actions: Action[];
          flows: Flow[];
          manuals: Manual[];
        };
        if (!alive) return;
        setActions(data.actions ?? []);
        setFlows(data.flows ?? []);
        setManuals(data.manuals ?? []);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const pick = (text: string) => {
    insertToChat(text);
    setOpen(false);
  };

  return (
    <OverlayModal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-2xl flex-col rounded-xl border border-hairline bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <Sparkles className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-medium">助手能力</h2>
          <p className="ml-2 text-xs text-text-4">点示例句直接填入输入条</p>
          <button
            type="button"
            aria-label="关闭" data-tip="关闭"
            className="ml-auto rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3">
          {failed ? (
            <p className="py-8 text-center text-xs text-text-4">
              能力清单拉取失败（agent 服务可能未启动）
            </p>
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-4">
                  能做什么
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {actions.map((a) => (
                    <div
                      key={a.title}
                      className="group rounded-lg border border-hairline bg-surface-2/50 p-2.5"
                    >
                      <p className="text-xs font-medium text-text">{a.title}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-text-3">
                        {a.desc}
                      </p>
                      <button
                        type="button"
                        className="mt-2 inline-flex max-w-full items-center gap-1 rounded-md border border-hairline bg-surface-1 px-2 py-1 text-left text-[11px] text-text-2 transition-colors hover:border-accent-soft hover:text-text"
                        onClick={() => pick(a.example)}
                      >
                        <Wand2 className="h-3 w-3 shrink-0 text-accent" />
                        <span className="truncate">{a.example}</span>
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              {flows.length > 0 ? (
                <section>
                  <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-4">
                    生成技能 · 输入条打 / 直达
                  </h3>
                  <div className="space-y-1.5">
                    {flows.map((f) => (
                      <button
                        key={f.name}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-surface-2/50 px-2.5 py-2 text-left transition-colors hover:border-accent-soft"
                        onClick={() => pick(`调用技能「${f.name}」处理：`)}
                      >
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                          /{f.name}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-text-3">
                          {f.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              <section>
                <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-4">
                  方法手册 · 助手执行任务时遵循的操作知识
                </h3>
                <div className="space-y-1.5">
                  {manuals.map((m) => (
                    <div
                      key={m.name}
                      className="rounded-lg border border-hairline bg-surface-2/50"
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
                        onClick={() =>
                          setExpanded(expanded === m.name ? null : m.name)
                        }
                      >
                        <BookOpen className="h-3.5 w-3.5 shrink-0 text-text-4" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs text-text">
                            {m.name}
                          </span>
                          <span className="block truncate text-[11px] text-text-3">
                            {m.description}
                          </span>
                        </span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${
                            expanded === m.name ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                      {expanded === m.name && m.body ? (
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-hairline px-3 py-2.5 font-mono text-[11px] leading-relaxed text-text-2">
                          {m.body}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </OverlayModal>
  );
}
