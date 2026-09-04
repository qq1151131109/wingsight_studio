"use client";

/**
 * 技能面板（Claude Code 式单一列表）：聊天 header「技能」按钮或
 * OPEN_CAPABILITIES_EVENT 呼出，OverlayModal portal。
 * 每项 = 名称 + 一行描述 + 点开看内容：
 *   手册类（agent/skills 的 SKILL.md）——助手执行对应任务时自动使用
 *   指令类（Langflow 技能）——输入条打 / 直达，展开内有「插入输入条」
 * 数据来自 GET /agent-service/capabilities（打开时现拉，手册即时更新）。
 */

import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, Sparkles, Wand2, X, Zap } from "lucide-react";
import OverlayModal from "@/components/canvas/OverlayModal";
import { apiFetch } from "@/lib/auth";
import {
  CHAT_INSERT_TEXT_EVENT,
  OPEN_CAPABILITIES_EVENT,
} from "@/lib/canvas/events";

type Skill = {
  name: string;
  description: string;
  kind: "manual" | "flow";
  body: string;
  params?: { name: string; desc?: string }[];
};

const KIND_META: Record<
  Skill["kind"],
  { label: string; icon: typeof BookOpen; cls: string }
> = {
  manual: { label: "手册", icon: BookOpen, cls: "text-text-4" },
  flow: { label: "指令", icon: Zap, cls: "text-accent" },
};

export default function CapabilitiesDialog() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Skill[]>([]);
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
        const data = (await r.json()) as { skills: Skill[] };
        if (alive) setList(data.skills ?? []);
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

  return (
    <OverlayModal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-xl flex-col rounded-xl border border-hairline bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <Sparkles className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-medium">技能</h2>
          <span className="text-xs text-text-4">{list.length} 项</span>
          <button
            type="button"
            aria-label="关闭" data-tip="关闭"
            className="ml-auto rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5">
          {failed ? (
            <p className="py-8 text-center text-xs text-text-4">
              技能清单拉取失败（agent 服务可能未启动）
            </p>
          ) : list.length === 0 ? (
            <p className="py-8 text-center text-xs text-text-4">加载中…</p>
          ) : (
            <div className="space-y-1.5">
              {list.map((s) => {
                const meta = KIND_META[s.kind];
                const Icon = meta.icon;
                const isOpen = expanded === s.name;
                return (
                  <div
                    key={`${s.kind}:${s.name}`}
                    className="rounded-lg border border-hairline bg-surface-2/50"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
                      onClick={() => setExpanded(isOpen ? null : s.name)}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${meta.cls}`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-text">
                            {s.name}
                          </span>
                          <span className="shrink-0 rounded bg-surface-1 px-1 py-px text-[10px] text-text-4">
                            {meta.label}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-text-3">
                          {s.description}
                        </span>
                      </span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    {isOpen ? (
                      <div className="border-t border-hairline px-3 py-2.5">
                        {s.kind === "manual" && s.body ? (
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-2">
                            {s.body}
                          </pre>
                        ) : null}
                        {s.kind === "flow" ? (
                          <div className="space-y-2">
                            {(s.params ?? []).length > 0 ? (
                              <ul className="space-y-1 text-[11px] text-text-3">
                                {(s.params ?? []).map((p) => (
                                  <li key={p.name}>
                                    <span className="font-mono text-text-2">
                                      {p.name}
                                    </span>
                                    ：{p.desc}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-[11px] text-text-3">
                                {s.description}
                              </p>
                            )}
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface-1 px-2.5 py-1.5 text-[11px] text-text-2 transition-colors hover:border-accent-soft hover:text-text"
                              onClick={() => {
                                window.dispatchEvent(
                                  new CustomEvent(CHAT_INSERT_TEXT_EVENT, {
                                    detail: {
                                      text: `调用技能「${s.name}」处理：`,
                                    },
                                  }),
                                );
                                setOpen(false);
                              }}
                            >
                              <Wand2 className="h-3 w-3 text-accent" />
                              插入输入条
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className="border-t border-hairline px-4 py-2.5 text-[11px] leading-relaxed text-text-4">
          手册类技能由助手执行对应任务时自动使用；指令类技能也可在输入条打 / 直达。
        </p>
      </div>
    </OverlayModal>
  );
}
