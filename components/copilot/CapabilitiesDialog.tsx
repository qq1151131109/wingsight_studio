"use client";

/**
 * 技能面板（Claude Code 同构：技能 = SKILL.md 操作手册）。
 * 聊天 header「技能」按钮或 OPEN_CAPABILITIES_EVENT 呼出，OverlayModal portal。
 * 每项 = 名称 + 一行描述 + 展开看手册全文 +「按此技能处理」点名入口
 * （对应 Claude Code 的 /技能名 显式调用；平时助手按任务自动采用）。
 * 管理员（can_edit）可直接编辑手册全文 / 新建技能，保存后 agent 热刷新目录。
 * Langflow 生成管线是工具不是技能，不在此列表（入口 = 输入条打 /）。
 */

import { useCallback, useEffect, useState } from "react";
import { BookOpen, ChevronDown, Plus, Sparkles, Wand2, X } from "lucide-react";
import OverlayModal from "@/components/canvas/OverlayModal";
import { apiFetch } from "@/lib/auth";
import {
  CHAT_INSERT_TEXT_EVENT,
  OPEN_CAPABILITIES_EVENT,
} from "@/lib/canvas/events";

type Skill = { name: string; description: string; body: string };

export default function CapabilitiesDialog() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Skill[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // 管理员编辑态：editing = 正在编辑的技能名，draft = SKILL.md 全文
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  // 新建表单
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newBody, setNewBody] = useState("");

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
        const data = (await r.json()) as { skills: Skill[]; can_edit?: boolean };
        if (!alive) return;
        setList(data.skills ?? []);
        setCanEdit(Boolean(data.can_edit));
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

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch("/agent-service/capabilities");
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { skills: Skill[]; can_edit?: boolean };
      setList(data.skills ?? []);
      setCanEdit(Boolean(data.can_edit));
    } catch {
      setFailed(true);
    }
  }, []);

  if (!open) return null;

  const saveEdit = async (name: string) => {
    setBusy(true);
    setSaveError("");
    try {
      const r = await apiFetch(
        `/agent-service/capabilities/skills/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: draft }),
        },
      );
      if (!r.ok) {
        setSaveError((await r.text()).slice(0, 120) || `保存失败 ${r.status}`);
        return;
      }
      setEditing(null);
      await refresh();
    } catch {
      setSaveError("网络错误，保存失败");
    } finally {
      setBusy(false);
    }
  };

  const createSkill = async () => {
    setBusy(true);
    setSaveError("");
    try {
      const r = await apiFetch("/agent-service/capabilities/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          description: newDesc,
          body: newBody,
        }),
      });
      if (!r.ok) {
        setSaveError((await r.text()).slice(0, 120) || `创建失败 ${r.status}`);
        return;
      }
      setCreating(false);
      setNewName("");
      setNewDesc("");
      setNewBody("");
      await refresh();
      setExpanded(newName);
    } catch {
      setSaveError("网络错误，创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6"
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
          {canEdit ? (
            <button
              type="button"
              data-track="chat.skills.create"
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[11px] text-text-2 transition-colors hover:border-accent-soft hover:text-text"
              onClick={() => {
                setCreating((c) => !c);
                setSaveError("");
              }}
            >
              <Plus className="h-3 w-3" />
              新建
            </button>
          ) : null}
          <button
            type="button"
            aria-label="关闭" data-tip="关闭"
            className={`rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text ${canEdit ? "" : "ml-auto"}`}
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {saveError ? (
          <p className="border-b border-hairline bg-danger/5 px-4 py-2 text-[11px] text-danger">
            {saveError}
          </p>
        ) : null}

        {creating && canEdit ? (
          <div className="space-y-2 border-b border-hairline px-4 py-3">
            <p className="text-[10px] uppercase tracking-wide text-text-4">
              新建技能
            </p>
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="名称（小写字母/数字/连字符，如 lip-analysis）"
                className="w-44 rounded-md border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-xs outline-none focus:border-accent-soft"
              />
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="描述（兼作助手触发条件，一句话）"
                className="min-w-0 flex-1 rounded-md border border-hairline bg-surface-2 px-2 py-1.5 text-xs outline-none focus:border-accent-soft"
              />
            </div>
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="手册正文（markdown，助手 read_skill 时读到的操作知识）"
              rows={4}
              className="w-full resize-y rounded-md border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-accent-soft"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || !newName.trim() || !newDesc.trim()}
                data-track="chat.skills.createSubmit"
                className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
                onClick={() => void createSkill()}
              >
                创建
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-[11px] text-text-3 hover:text-text"
                onClick={() => setCreating(false)}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

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
                const isOpen = expanded === s.name;
                const isEditing = editing === s.name;
                return (
                  <div
                    key={s.name}
                    className="rounded-lg border border-hairline bg-surface-2/50"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
                      onClick={() => setExpanded(isOpen ? null : s.name)}
                    >
                      <BookOpen className="h-4 w-4 shrink-0 text-text-4" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-text">
                          {s.name}
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
                        {isEditing ? (
                          <div className="space-y-2">
                            <textarea
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              rows={14}
                              spellCheck={false}
                              className="w-full resize-y rounded-md border border-hairline bg-surface-1 px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-accent-soft"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                data-track="chat.skills.editSave"
                                className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
                                onClick={() => void saveEdit(s.name)}
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                className="rounded-md px-3 py-1.5 text-[11px] text-text-3 hover:text-text"
                                onClick={() => setEditing(null)}
                              >
                                取消
                              </button>
                              <span className="text-[10px] text-text-4">
                                保存即生效（agent 热刷新，无需重启）
                              </span>
                            </div>
                          </div>
                        ) : (
                          <>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-2">
                              {s.body}
                            </pre>
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                type="button"
                                data-track="chat.skills.invoke"
                                className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface-1 px-2.5 py-1.5 text-[11px] text-text-2 transition-colors hover:border-accent-soft hover:text-text"
                                onClick={() => {
                                  window.dispatchEvent(
                                    new CustomEvent(CHAT_INSERT_TEXT_EVENT, {
                                      detail: {
                                        text: `请按技能「${s.name}」的规则处理：`,
                                      },
                                    }),
                                  );
                                  setOpen(false);
                                }}
                              >
                                <Wand2 className="h-3 w-3 text-accent" />
                                按此技能处理
                              </button>
                              {canEdit ? (
                                <button
                                  type="button"
                                  data-track="chat.skills.editStart"
                                  className="rounded-md border border-hairline bg-surface-1 px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:border-accent-soft hover:text-text"
                                  onClick={() => {
                                    setEditing(s.name);
                                    setDraft(s.body);
                                    setSaveError("");
                                  }}
                                >
                                  编辑
                                </button>
                              ) : null}
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className="border-t border-hairline px-4 py-2.5 text-[11px] leading-relaxed text-text-4">
          技能是助手的操作手册：对应任务会自动采用，也可点名使用。生成管线（如宣发文案）属工具，在输入条打 / 直达。
        </p>
      </div>
    </OverlayModal>
  );
}
