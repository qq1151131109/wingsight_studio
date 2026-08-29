"use client";

/**
 * 提示词库面板（对标 open-storyboard-canvas PromptLibrary）：内置影视域预设 +
 * 用户收藏，点选追加进当前生成输入面板（PROMPT_PICK_EVENT）。
 */

import { useEffect, useState } from "react";
import { Search, Star, X } from "lucide-react";
import {
  PROMPT_PRESETS,
  loadFavorites,
  toggleFavorite,
} from "@/lib/prompt-library";
import { PROMPT_PICK_EVENT, type PromptPickDetail } from "@/lib/canvas/events";

export default function PromptLibraryPanel({ onClose }: { onClose: () => void }) {
  const [favs, setFavs] = useState<string[]>(() => loadFavorites());
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const k = q.trim().toLowerCase();
  const favItems = favs.filter((t) => !k || t.toLowerCase().includes(k));
  const presets = PROMPT_PRESETS.filter((p) => !k || p.text.toLowerCase().includes(k));

  const pick = (text: string) =>
    window.dispatchEvent(
      new CustomEvent<PromptPickDetail>(PROMPT_PICK_EVENT, { detail: { text } }),
    );

  return (
    <div className="absolute left-2 top-14 z-20 flex max-h-[62vh] w-64 flex-col rounded-lg border border-hairline bg-surface-1 p-2 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-text">提示词库</h3>
        <button
          type="button"
          title="关闭（Esc）"
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
      <div className="nowheel mt-1.5 flex flex-1 flex-col gap-1 overflow-y-auto">
        {favItems.length > 0 ? (
          <p className="px-1 pt-1 text-[10px] text-text-4">收藏</p>
        ) : null}
        {favItems.map((t) => (
          <PromptRow
            key={t}
            text={t}
            fav
            onPick={() => pick(t)}
            onFav={() => setFavs(toggleFavorite(t))}
          />
        ))}
        <p className="px-1 pt-1 text-[10px] text-text-4">内置 · 点击追加到输入区</p>
        {presets.map((p) => (
          <PromptRow
            key={p.text}
            text={p.text}
            group={p.group}
            fav={favs.includes(p.text)}
            onPick={() => pick(p.text)}
            onFav={() => setFavs(toggleFavorite(p.text))}
          />
        ))}
        {favItems.length === 0 && presets.length === 0 ? (
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
}: {
  text: string;
  group?: string;
  fav: boolean;
  onPick: () => void;
  onFav: () => void;
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
      <button
        type="button"
        title={fav ? "取消收藏" : "收藏"}
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
    </div>
  );
}
