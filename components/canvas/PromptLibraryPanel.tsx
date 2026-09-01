"use client";

/**
 * 提示词库面板：内置影视域预设 + 「我的提示词」（服务端按账号隔离，可直接
 * 添加/编辑/删除），点选追加进当前生成输入面板（PROMPT_PICK_EVENT）。
 * 内置条目星标 = 存一份进「我的」（再点 = 移除）；我的条目 hover 出编辑/删除。
 */

import { useEffect, useState } from "react";
import { Pencil, Plus, Search, Star, Trash2, X } from "lucide-react";
import {
  PROMPT_PRESETS,
  createMyPrompt,
  deleteMyPrompt,
  listMyPrompts,
  migrateLegacyFavorites,
  updateMyPrompt,
  type MyPrompt,
} from "@/lib/prompt-library";
import { PROMPT_PICK_EVENT, type PromptPickDetail } from "@/lib/canvas/events";

export default function PromptLibraryPanel({ onClose }: { onClose: () => void }) {
  const [mine, setMine] = useState<MyPrompt[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  /** null=收起；"new"=新增；MyPrompt=编辑该条 */
  const [form, setForm] = useState<"new" | MyPrompt | null>(null);
  const [formGroup, setFormGroup] = useState("");
  const [formText, setFormText] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (form) {
        setForm(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, form]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await migrateLegacyFavorites();
        if (alive) setMine(list);
      } catch {
        // 迁移失败（部分成功会保留下次重试）：退化为纯列表加载，错误上浮
        try {
          const list = await listMyPrompts();
          if (alive) setMine(list);
        } catch (e2) {
          if (alive) {
            setMine([]);
            setErr(e2 instanceof Error ? e2.message : "提示词库加载失败");
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const k = q.trim().toLowerCase();
  const mineItems = (mine ?? []).filter((p) => !k || p.text.toLowerCase().includes(k));
  const presets = PROMPT_PRESETS.filter((p) => !k || p.text.toLowerCase().includes(k));

  const pick = (text: string) =>
    window.dispatchEvent(
      new CustomEvent<PromptPickDetail>(PROMPT_PICK_EVENT, { detail: { text } }),
    );

  const openAdd = () => {
    setForm("new");
    setFormGroup("");
    setFormText("");
  };
  const openEdit = (p: MyPrompt) => {
    setForm(p);
    setFormGroup(p.group);
    setFormText(p.text);
  };
  const saveForm = async () => {
    if (!formText.trim()) {
      setErr("提示词内容不能为空");
      return;
    }
    setErr("");
    try {
      if (form === "new") {
        const p = await createMyPrompt(formGroup.trim(), formText.trim());
        setMine((prev) => [p, ...(prev ?? [])]);
      } else if (form) {
        const p = await updateMyPrompt(form.id, {
          group: formGroup.trim(),
          text: formText.trim(),
        });
        setMine((prev) => (prev ?? []).map((x) => (x.id === p.id ? p : x)));
      }
      setForm(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    }
  };
  const removeRow = async (p: MyPrompt) => {
    const head = p.text.slice(0, 12) + (p.text.length > 12 ? "…" : "");
    if (!window.confirm(`删除提示词「${head}」？`)) return;
    setErr("");
    try {
      await deleteMyPrompt(p.id);
      setMine((prev) => (prev ?? []).filter((x) => x.id !== p.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    }
  };
  /** 内置星标：存一份进「我的」（已在则移除） */
  const toggleBuiltin = async (p: (typeof PROMPT_PRESETS)[number]) => {
    if (!mine) return;
    const owned = mine.find((m) => m.text === p.text);
    setErr("");
    try {
      if (owned) {
        await deleteMyPrompt(owned.id);
        setMine((prev) => (prev ?? []).filter((x) => x.id !== owned.id));
      } else {
        const created = await createMyPrompt(p.group, p.text);
        setMine((prev) => [created, ...(prev ?? [])]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "操作失败");
    }
  };

  return (
    <div className="absolute left-2 top-14 z-20 flex max-h-[62vh] w-64 flex-col rounded-lg border border-hairline bg-surface-1 p-2 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-text">提示词库</h3>
        <button
          type="button"
          data-tip="关闭（Esc）" aria-label="关闭（Esc）"
          className="nodrag rounded p-0.5 text-text-4 hover:text-text"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface-2 px-1.5">
        <Search className="h-3 w-3 shrink-0 text-text-4" />
        <input
          value={q}
          placeholder="搜索提示词…"
          className="w-full bg-transparent text-[11px] text-text outline-none placeholder:text-text-4"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {err ? <p className="mt-1 px-1 text-[10px] text-danger">{err}</p> : null}
      <div className="nowheel mt-1.5 flex flex-1 flex-col gap-1 overflow-y-auto">
        <div className="flex items-center justify-between px-1 pt-1">
          <p className="text-[10px] text-text-4">我的 · 点击追加，可编辑</p>
          <button
            type="button"
            data-tip="添加提示词" aria-label="添加提示词"
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={openAdd}
          >
            <Plus className="h-3 w-3" />
            添加
          </button>
        </div>
        {form ? (
          <div className="rounded-md border border-accent-soft bg-surface-2 p-1.5">
            <input
              value={formGroup}
              placeholder="分组（可选，如 光影/质感）"
              maxLength={20}
              className="w-full rounded border border-hairline bg-surface-1 px-1.5 py-1 text-[11px] text-text outline-none focus:border-accent placeholder:text-text-4"
              onChange={(e) => setFormGroup(e.target.value)}
            />
            <textarea
              value={formText}
              placeholder="提示词内容…"
              rows={3}
              className="nowheel mt-1 w-full resize-none rounded border border-hairline bg-surface-1 px-1.5 py-1 text-[11px] leading-relaxed text-text outline-none focus:border-accent placeholder:text-text-4"
              onChange={(e) => setFormText(e.target.value)}
            />
            <div className="mt-1 flex justify-end gap-1">
              <button
                type="button"
                className="rounded border border-hairline px-2 py-0.5 text-[10px] text-text-2 transition-colors hover:bg-surface-2"
                onClick={() => setForm(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-white transition-opacity hover:opacity-85"
                onClick={() => void saveForm()}
              >
                {form === "new" ? "添加" : "保存"}
              </button>
            </div>
          </div>
        ) : null}
        {mine === null ? (
          <p className="py-3 text-center text-[11px] text-text-4">加载中…</p>
        ) : (
          <>
            {mineItems.map((p) => (
              <PromptRow
                key={p.id}
                text={p.text}
                group={p.group}
                onPick={() => pick(p.text)}
                onEdit={() => openEdit(p)}
                onRemove={() => void removeRow(p)}
              />
            ))}
            {mineItems.length === 0 ? (
              <p className="px-1 py-2 text-[10px] leading-relaxed text-text-4">
                还没有自建提示词：点「添加」手写，或收藏下方内置条目后改造成自己的
              </p>
            ) : null}
          </>
        )}
        <p className="px-1 pt-1 text-[10px] text-text-4">内置 · 点击追加到输入区</p>
        {presets.map((p) => {
          const owned = mine?.some((m) => m.text === p.text) ?? false;
          return (
            <PromptRow
              key={p.text}
              text={p.text}
              group={p.group}
              fav={owned}
              onPick={() => pick(p.text)}
              onFav={() => void toggleBuiltin(p)}
            />
          );
        })}
        {mineItems.length === 0 && presets.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-text-4">无匹配</p>
        ) : null}
      </div>
    </div>
  );
}

function PromptRow({
  text,
  group,
  fav,
  onPick,
  onFav,
  onEdit,
  onRemove,
}: {
  text: string;
  group?: string;
  /** 内置条目专用：已存入「我的」 */
  fav?: boolean;
  onPick: () => void;
  onFav?: () => void;
  /** 我的条目专用：hover 编辑/删除 */
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className="group/prow flex cursor-pointer items-start gap-1 rounded-md border border-hairline bg-surface-2 px-1.5 py-1 transition-colors hover:border-accent"
      title="点击追加到生成输入区"
      onClick={onPick}
    >
      <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-text-2">
        {group ? (
          <span className="mr-1 rounded bg-surface-1 px-1 text-[9px] text-text-4">
            {group}
          </span>
        ) : null}
        {text}
      </span>
      {onEdit ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-tip="编辑" aria-label="编辑提示词"
            className="p-0.5 text-text-4 opacity-0 transition-colors group-hover/prow:opacity-100 hover:text-text"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-tip="删除" aria-label="删除提示词"
            className="p-0.5 text-text-4 opacity-0 transition-colors group-hover/prow:opacity-100 hover:text-danger"
            onClick={(e) => {
              e.stopPropagation();
              onRemove?.();
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      ) : null}
      {onFav ? (
        <button
          type="button"
          data-tip={fav ? "从「我的」移除" : "存入「我的」提示词"} aria-label={fav ? "从「我的」移除" : "存入「我的」提示词"}
          className={`shrink-0 p-0.5 transition-colors ${
            fav ? "text-warn" : "text-text-4 opacity-0 group-hover/prow:opacity-100 hover:text-warn"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onFav();
          }}
        >
          <Star className={`h-3 w-3 ${fav ? "fill-current" : ""}`} />
        </button>
      ) : null}
    </div>
  );
}
