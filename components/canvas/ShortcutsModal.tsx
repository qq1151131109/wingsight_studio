"use client";

/**
 * 快捷键速查表（对标 open-ai-canvas canvas-shortcuts-modal）：? 键（Shift+/）
 * 呼出，可搜索、按分类过滤；数据驱动，与实际绑定一一对应。
 */

import { useEffect, useMemo, useState } from "react";
import { Keyboard, Search, X } from "lucide-react";
import OverlayModal from "./OverlayModal";

interface ShortcutItem {
  keys: string[];
  title: string;
  group: string;
}

const SHORTCUTS: ShortcutItem[] = [
  { keys: ["⌘Z"], title: "撤销", group: "画布" },
  { keys: ["⇧⌘Z", "Ctrl+Y"], title: "重做", group: "画布" },
  { keys: ["⌘C"], title: "复制选中卡片", group: "画布" },
  { keys: ["⌘X"], title: "剪切选中卡片", group: "画布" },
  { keys: ["⌘V"], title: "粘贴卡片 / 图片 / 文本（文本直接建卡）", group: "画布" },
  { keys: ["⌘D"], title: "原地复制", group: "画布" },
  { keys: ["⌘A"], title: "全选", group: "画布" },
  { keys: ["Backspace"], title: "删除选中", group: "画布" },
  { keys: ["Esc"], title: "清空选区 / 关闭弹层", group: "画布" },
  { keys: ["↑↓←→"], title: "微调选中卡 1px", group: "画布" },
  { keys: ["⇧+方向键"], title: "按网格 16px 微调", group: "画布" },
  { keys: ["?"], title: "快捷键速查表", group: "画布" },
  { keys: ["左拖空白"], title: "框选", group: "画布" },
  { keys: ["中键拖 / Space+拖"], title: "平移画布", group: "画布" },
  { keys: ["双指滚动"], title: "平移（触控板）", group: "画布" },
  { keys: ["⌘+滚轮 / 捏合"], title: "缩放", group: "画布" },
  { keys: ["双击空白"], title: "添加节点选择器", group: "节点" },
  { keys: ["右键空白"], title: "上传 / 导航 / 建卡菜单", group: "节点" },
  { keys: ["Alt+拖卡"], title: "原位克隆", group: "节点" },
  { keys: ["双击标题/正文"], title: "就地编辑", group: "节点" },
  { keys: ["拖动加号"], title: "卡片间连线", group: "节点" },
  { keys: ["选中卡片"], title: "卡下方浮出生成输入区", group: "生成" },
  { keys: ["@"], title: "引用画布卡片保持一致", group: "生成" },
  { keys: ["Ctrl+Enter"], title: "提交生成 / 保存正文", group: "生成" },
];

const GROUPS = ["全部", "画布", "节点", "生成"];

export default function ShortcutsModal() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("全部");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (typing) return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const k = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      SHORTCUTS.filter(
        (s) =>
          (group === "全部" || s.group === group) &&
          (!k ||
            s.title.toLowerCase().includes(k) ||
            s.keys.some((key) => key.toLowerCase().includes(k))),
      ),
    [k, group],
  );

  if (!open) return null;
  return (
    <OverlayModal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex max-h-[76vh] w-full max-w-xl flex-col gap-2.5 rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <Keyboard className="h-4 w-4" />
            快捷键
          </h3>
          <button
            type="button"
            data-tip="关闭"
            aria-label="关闭"
            className="rounded p-0.5 text-text-4 hover:text-text"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex h-7 flex-1 items-center gap-1 rounded-md border border-hairline bg-surface-2 px-2">
            <Search className="h-3 w-3 shrink-0 text-text-4" />
            <input
              autoFocus
              value={q}
              placeholder="搜索快捷键…"
              className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-4"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              className={`rounded-md px-1.5 py-1 text-[10px] transition-colors ${
                group === g
                  ? "bg-accent-dim text-text"
                  : "text-text-3 hover:bg-surface-2 hover:text-text"
              }`}
              onClick={() => setGroup(g)}
            >
              {g}
            </button>
          ))}
        </div>
        <div className="nowheel grid grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
          {shown.map((s) => (
            <div
              key={s.title}
              className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-surface-2/60 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-text-2">
                {s.title}
              </span>
              <span className="flex shrink-0 gap-1">
                {s.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded border border-hairline bg-surface-1 px-1.5 py-0.5 font-sans text-[10px] text-text-3"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
          {shown.length === 0 ? (
            <p className="col-span-full py-6 text-center text-xs text-text-4">
              无匹配
            </p>
          ) : null}
        </div>
      </div>
    </OverlayModal>
  );
}
