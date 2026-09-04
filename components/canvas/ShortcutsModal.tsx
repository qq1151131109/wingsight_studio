"use client";

/**
 * 快捷键速查表（对标 open-ai-canvas canvas-shortcuts-modal + 竞品四栏面板）：
 * ? 键（Shift+/）或底部坞键盘按钮呼出，可搜索、按分类过滤；数据驱动，
 * 与 CanvasShortcuts.tsx 的实际绑定一一对应（改键两处同步）。
 */

import { useEffect, useMemo, useState } from "react";
import { Keyboard, Search, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { OPEN_SHORTCUTS_EVENT } from "@/lib/canvas/events";

interface ShortcutItem {
  keys: string[];
  title: string;
  group: string;
}

const SHORTCUTS: ShortcutItem[] = [
  // —— 创作 ——
  { keys: ["⌘", "G"], title: "成组（选中 ≥2 张卡）", group: "创作" },
  { keys: ["⌘", "⇧", "G"], title: "解组选中的分组框", group: "创作" },
  { keys: ["⌘", "L"], title: "连线（选中两张卡）", group: "创作" },
  { keys: ["⌘", "D"], title: "原地复制", group: "创作" },
  { keys: ["⌘", "↵"], title: "生成选中卡（出图类）", group: "创作" },
  { keys: ["Tab"], title: "新建节点（视口中央）", group: "创作" },
  { keys: ["⌥", "拖卡"], title: "原位克隆", group: "创作" },
  { keys: ["拖动加号"], title: "卡片间连线", group: "创作" },
  { keys: ["双击标题/正文"], title: "就地编辑", group: "创作" },
  { keys: ["@"], title: "引用画布卡片保持一致", group: "创作" },
  { keys: ["Ctrl", "↵"], title: "输入条内提交生成/撰写", group: "创作" },
  { keys: ["⌘", "C"], title: "复制选中卡片", group: "创作" },
  { keys: ["⌘", "X"], title: "剪切选中卡片", group: "创作" },
  { keys: ["⌘", "V"], title: "粘贴卡片 / 图片 / 文本", group: "创作" },
  { keys: ["⌘", "A"], title: "全选", group: "创作" },
  // —— 缩放 ——
  { keys: ["⌘", "0"], title: "适应画布（显示全部内容）", group: "缩放" },
  { keys: ["⇧", "⌘", "0"], title: "复位 100%", group: "缩放" },
  { keys: ["⌘", "+/-"], title: "放大 / 缩小", group: "缩放" },
  { keys: ["捏合"], title: "缩放（触控板）", group: "缩放" },
  { keys: ["⌘", "滚轮"], title: "缩放（鼠标）", group: "缩放" },
  // —— 移动画布 ——
  { keys: ["Space", "拖"], title: "平移（键盘配合）", group: "移动画布" },
  { keys: ["中键拖"], title: "平移", group: "移动画布" },
  { keys: ["滚轮 / 双指"], title: "平移（物理跟速）", group: "移动画布" },
  { keys: ["↑↓←→"], title: "微调选中卡 1px", group: "移动画布" },
  { keys: ["⇧", "方向键"], title: "按网格 16px 微调", group: "移动画布" },
  { keys: ["⇧", "F"], title: "整理画布 / 选区", group: "移动画布" },
  // —— 其他 ——
  { keys: ["⌘", "Z"], title: "撤销", group: "其他" },
  { keys: ["⇧⌘Z", "Ctrl+Y"], title: "重做", group: "其他" },
  { keys: ["Backspace"], title: "删除选中", group: "其他" },
  { keys: ["Esc"], title: "清空选区 / 关闭弹层", group: "其他" },
  { keys: ["左拖空白"], title: "框选", group: "其他" },
  { keys: ["⇧E"], title: "显示 / 隐藏画布连线", group: "其他" },
  { keys: ["双击空白"], title: "添加节点选择器", group: "其他" },
  { keys: ["右键空白"], title: "上传 / 导航 / 建卡菜单", group: "其他" },
  { keys: ["?"], title: "快捷键速查表", group: "其他" },
];

const GROUPS = ["全部", "创作", "缩放", "移动画布", "其他"];

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
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
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
  const groupsShown = GROUPS.filter(
    (g) => g !== "全部" && (group === "全部" || group === g) &&
      shown.some((s) => s.group === g),
  );

  if (!open) return null;
  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-4xl flex-col gap-2.5 rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
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
        <div className="nowheel grid grid-cols-1 gap-x-5 gap-y-3 overflow-y-auto sm:grid-cols-2 lg:grid-cols-4">
          {groupsShown.map((g) => (
            <div key={g} className="min-w-0">
              <h4 className="mb-1 px-0.5 text-xs font-semibold text-accent">
                {g}
              </h4>
              <div className="flex flex-col gap-1">
                {shown
                  .filter((s) => s.group === g)
                  .map((s) => (
                    <div
                      key={s.title}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-[11px] text-text-2">
                        {s.title}
                      </span>
                      <span className="flex shrink-0 gap-0.5">
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
              </div>
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
