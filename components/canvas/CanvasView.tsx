"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useStoreApi,
  type EdgeMouseHandler,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnBeforeDelete,
  type OnConnectEnd,
  type OnMove,
  type OnMoveEnd,
  type OnNodeDrag,
  type OnReconnect,
  type Viewport,
} from "@xyflow/react";
import {
  Camera,
  ChevronRight,
  Image as ImageIcon,
  Info,
  Library,
  ListTree,
  Loader2,
  Lock,
  LockOpen,
  Palette,
  Pencil,
  Plus,
  Redo2,
  Search,
  Trash2,
  Undo2,
  WandSparkles,
  X,
  Keyboard,
  ZoomIn as ZoomInIcon,
  ZoomOut,
  Maximize,
} from "lucide-react";
import {
  selectionBoxes,
  NODE_META,
  summarizeCanvas,
  useCanvasStore,
  type WingEdge,
  type WingNode,
  type WingNodeType,
} from "@/lib/canvas/store";
import { TYPE_ICONS } from "@/lib/canvas/type-icons";
import {
  dispatchFocusEdit,
  FOCUS_NODES_EVENT,
  IMAGE_TOOL_EVENT,
  NODE_INFO_EVENT,
  OPEN_ADD_MENU_EVENT,
  OPEN_SHORTCUTS_EVENT,
  OPEN_STYLE_EVENT,
  type FocusNodesDetail,
  type NodeInfoDetail,
} from "@/lib/canvas/events";
import { copyImageToClipboard, downloadMedia } from "@/lib/download";
import { showToast } from "@/lib/toast";
import { trackEvent } from "@/lib/telemetry";
import { ASSET_TYPES } from "@/lib/canvas/shotRefs";
import { toggleFreeResize } from "@/lib/canvas/imageTools";
import { downloadBlobFile, mergeImagesToGrid } from "@/lib/canvas/gridMerge";
import { useImageModels, type ImageModelOption } from "@/lib/imagegen";
import { uploadAsset } from "@/lib/projects";
import { useCanvasPref } from "@/lib/canvas/prefs";
import { STYLE_CATEGORIES, STYLE_PRESETS } from "@/lib/canvas/style-presets";
import {
  createMyStyle,
  deleteMyStyle,
  listMyStyles,
  reverseStyle,
  updateMyStyle,
  type MyStyle,
} from "@/lib/styles";
import { nodeTypes, NodeInfoModal } from "./nodes";
import DeletableEdge from "./edges";
import CanvasShortcuts from "./CanvasShortcuts";
import AssetTray, { AssetAutoRecorder } from "./AssetTray";
import NodeInputPanel from "./NodeInputPanel";
import { prefillTextWrite } from "./PromptBar";
import PromptLibraryPanel from "./PromptLibraryPanel";
import ShortcutsModal from "./ShortcutsModal";
import OverlayModal from "./OverlayModal";
import ServiceBanner from "./ServiceBanner";
import OutlinePanel from "./OutlinePanel";
import DirectorPanel from "./DirectorPanel";
import ImageToolDialogs from "./ImageToolDialogs";
import CanvasSettings from "./CanvasSettings";

/** 离线指示：断网时顶部常驻小条（保存走 saveState "offline" 文案，这里补全局感知） */
function OfflineIndicator() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-1.5 text-xs text-warn shadow">
      离线中 · 变更暂存本地，联网后自动同步
    </div>
  );
}

/** 视口相等判断（按值比较，防程序化 setViewport 与 store 回写互触发） */
const vpEq = (a: Viewport, b: Viewport) =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/**
 * 右键/双击菜单（六态）：pane=空白右键（sub="add" 时原位切换成节点类型列表，
 * 对标 reference 产品的二级展开）；add=双击空白的"添加节点"选择器。
 */
type CtxMenu =
  | {
      kind: "pane";
      x: number;
      y: number;
      fx: number;
      fy: number;
      sub: null | "add";
    }
  | { kind: "add"; x: number; y: number; fx: number; fy: number }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "convert"; x: number; y: number; id: string }
  | { kind: "selection"; x: number; y: number; ids: string[] }
  | { kind: "edge"; x: number; y: number; id: string };

/** 连接校验：禁自环与重复边（对标 osc 的 connection rules，取最常用两条） */
const CONVERT_TYPES: WingNodeType[] = [
  "note",
  "script",
  "character",
  "image",
  "video",
  "audio",
];

function CtxItem({
  label,
  dot,
  icon,
  shortcut,
  chevron,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  dot?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  chevron?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 ${
        danger ? "text-danger" : "text-text-2 hover:text-text"
      } disabled:cursor-not-allowed disabled:text-text-4 disabled:hover:bg-transparent`}
      onClick={onClick}
    >
      {dot ? (
        <span className="ws-card-dot" style={{ background: dot }} />
      ) : icon ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {label}
      <span className="ml-auto" />
      {shortcut ? (
        <span className="ml-3 text-[10px] tabular-nums text-text-4">
          {shortcut}
        </span>
      ) : null}
      {chevron ? (
        <ChevronRight className="ml-3 h-3 w-3 shrink-0 text-text-4" />
      ) : null}
    </button>
  );
}

const CtxSep = () => <div className="mx-1 my-1 h-px bg-hairline" />;

/** "添加节点"类型列表：双击选择器与右键二级展开共用。
 *  底部带「添加资源」分组（上传/素材库），结构对标 libtv 的建卡菜单 */
function NodeAddMenu({
  onPick,
  onUpload,
  onTray,
}: {
  onPick: (t: WingNodeType) => void;
  onUpload?: () => void;
  onTray?: () => void;
}) {
  return (
    <div className="flex min-w-[140px] flex-col">
      <p className="px-2 py-1 text-[10px] text-text-4">添加节点</p>
      {NODE_TYPE_ITEMS.map(({ type, key }) => {
        const Icon = TYPE_ICONS[type];
        return (
          <CtxItem
            key={key}
            label={NODE_META[type].label}
            icon={Icon ? <Icon className="h-4 w-4" /> : null}
            onClick={() => onPick(type)}
          />
        );
      })}
      {onUpload || onTray ? (
        <>
          <CtxSep />
          <p className="px-2 py-1 text-[10px] text-text-4">添加资源</p>
          {onUpload ? <CtxItem label="上传" onClick={onUpload} /> : null}
          {onTray ? <CtxItem label="素材库…" onClick={onTray} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** 节点类型清单：工具条 / 双击选择器 / 右键"添加节点"三处共用（图标见 type-icons）。
 *  顺序对标 libtv：文本→图片→视频→智能剪辑→音频→脚本，影视特化卡排后 */
const NODE_TYPE_ITEMS: { type: WingNodeType; key: string }[] = (
  [
    "note",
    "image",
    "video",
    "compose",
    "audio",
    "script",
    "character",
    "scene",
    "prop",
    "costume",
    "shotlist",
  ] as WingNodeType[]
).map((type) => ({ type, key: `i-${type}` }));

/** 拖拽导入：图片→上传建 image 卡；.txt/.md→文本卡（md 当剧本、txt 当文本） */
async function importDroppedFiles(
  files: File[],
  at: { x: number; y: number },
) {
  const store = useCanvasStore.getState();
  let i = 0;
  for (const f of files) {
    const position = {
      x: at.x + (i % 4) * 288,
      y: at.y + Math.floor(i / 4) * 300,
    };
    const name = f.name.replace(/\.[^.]+$/, "").slice(0, 40);
    if (f.type.startsWith("image/")) {
      try {
        const url = await uploadAsset(f);
        if (!url) continue;
        store.addNode({
          position,
          data: {
            nodeType: "image",
            title: name || "导入图片",
            body: "",
            imageUrl: url,
            status: "ready",
          },
        });
        i += 1;
      } catch {
        /* 上传失败跳过该文件 */
      }
    } else if (f.type.startsWith("video/")) {
      try {
        const url = await uploadAsset(f, f.type);
        if (!url) continue;
        store.addNode({
          position,
          data: {
            nodeType: "video",
            title: name || "导入视频",
            body: "",
            videoUrl: url,
            status: "ready",
          },
        });
        i += 1;
      } catch {
        /* 上传失败跳过该文件 */
      }
    } else if (f.type.startsWith("audio/")) {
      try {
        const url = await uploadAsset(f, f.type, f.name);
        if (!url) continue;
        store.addNode({
          position,
          data: {
            nodeType: "audio",
            title: name || "导入音频",
            body: "",
            audioUrl: url,
          },
        });
        i += 1;
      } catch {
        /* 上传失败跳过该文件 */
      }
    } else if (/\.(txt|md|markdown)$/i.test(f.name)) {
      try {
        const text = (await f.text()).slice(0, 8000);
        const isMd = /\.md$|\.markdown$/i.test(f.name);
        store.addNode({
          position,
          data: {
            nodeType: isMd ? "script" : "note",
            title: name || "导入文本",
            body: text,
          },
        });
        i += 1;
      } catch {
        /* 读取失败跳过该文件 */
      }
    }
  }
}

/** 节点搜索：标题/正文匹配，点击定位（选中 + 运镜） */
function NodeSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const nodes = useCanvasStore((s) => s.nodes);
  const results = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return [];
    return nodes
      .filter(
        (n) =>
          (n.data.title ?? "").toLowerCase().includes(k) ||
          (n.data.body ?? "").slice(0, 120).toLowerCase().includes(k),
      )
      .slice(0, 8);
  }, [q, nodes]);

  const pick = (id: string) => {
    useCanvasStore.getState().selectNodes([id]);
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
    );
    setQ("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex h-10 w-52 items-center gap-1.5 rounded-lg border border-hairline bg-surface-1 px-2 shadow-sm">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-4" />
        <input
          value={q}
          placeholder="搜索画布卡片…"
          className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-4"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length > 0) pick(results[0].id);
            if (e.key === "Escape") {
              setQ("");
              setOpen(false);
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      {open && q.trim() && results.length > 0 ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          {results.map((n) => (
            <button
              key={n.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              onClick={() => pick(n.id)}
            >
              <span
                className="ws-card-dot shrink-0"
                style={{
                  background:
                    NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.dot,
                }}
              />
              <span className="truncate">{n.data.title || "（无标题）"}</span>
              <span className="ml-auto shrink-0 text-[10px] text-text-4">
                {NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.label}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 我的画风分类名（画风面板首个分类） */
const MY_STYLE_CAT = "我的画风";

/** 新建/编辑自建画风：名称 + 画风描述 + 可选封面；支持上传参考图让 AI 反推
 *  画风描述（gemini 视觉 flow，异步任务轮询）。保存后落在「我的画风」分类，
 *  所有项目可复用（owner 隔离）。 */
function StyleEditDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: MyStyle | null;
  onClose: () => void;
  onSaved: (s: MyStyle) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [coverUrl, setCoverUrl] = useState(initial?.coverUrl ?? "");
  const [busy, setBusy] = useState<"" | "reverse" | "cover" | "save">("");
  const [err, setErr] = useState("");
  const reverseRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  const pickImage = async (file: File | undefined, kind: "reverse" | "cover") => {
    if (!file) return;
    setErr("");
    setBusy(kind);
    try {
      const url = await uploadAsset(file, file.type, file.name);
      if (!url) throw new Error("图片上传失败");
      if (kind === "cover") {
        setCoverUrl(url);
      } else {
        const text = await reverseStyle([url]);
        if (!text.trim()) throw new Error("反推结果为空，换张参考图试试");
        setPrompt(text.trim());
        if (!coverUrl) setCoverUrl(url); // 反推图顺手当封面
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!name.trim() || !prompt.trim()) {
      setErr("名称与画风描述不能为空");
      return;
    }
    setErr("");
    setBusy("save");
    try {
      const s = initial
        ? await updateMyStyle(initial.id, {
            name: name.trim(),
            prompt: prompt.trim(),
            coverUrl,
          })
        : await createMyStyle({ name: name.trim(), prompt: prompt.trim(), coverUrl });
      onSaved(s);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  };

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/55 p-6"
      onClick={busy === "save" ? undefined : onClose}
    >
      <div
        className="w-[min(34rem,92vw)] rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-text">
              {initial ? "编辑画风" : "新建画风"}
            </p>
            <p className="mt-0.5 text-[11px] text-text-4">
              保存在「我的画风」，所有项目可复用；点选卡片即套用为项目画风
            </p>
          </div>
          <button
            type="button"
            data-tip="关闭" aria-label="关闭"
            className="rounded-md p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mt-3 block text-[11px] font-medium text-text-2">名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：敦煌厚涂风"
          maxLength={80}
          className="mt-1 w-full rounded-md border border-hairline bg-surface-2/60 px-2 py-1.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
        />
        <div className="mt-2.5 flex items-center justify-between">
          <label className="text-[11px] font-medium text-text-2">画风描述</label>
          <button
            type="button"
            disabled={busy !== ""}
            data-tip="上传参考图，AI 提炼画风描述" aria-label="上传参考图，AI 提炼画风描述"
            className="flex items-center gap-1 rounded border border-hairline px-1.5 py-0.5 text-[10px] text-text-2 transition-colors hover:border-accent-soft hover:text-text disabled:opacity-50"
            onClick={() => reverseRef.current?.click()}
          >
            {busy === "reverse" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <WandSparkles className="h-3 w-3" />
            )}
            从参考图反推
          </button>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="点「从参考图反推」让 AI 起草，或直接写：媒介笔触、色彩、光线、质感、年代感…"
          rows={5}
          className="nowheel mt-1 w-full resize-none rounded-md border border-hairline bg-surface-2/60 p-2 text-xs leading-relaxed text-text outline-none focus:border-accent placeholder:text-text-4"
        />
        <div className="mt-2.5 flex items-center gap-2">
          <span className="text-[11px] font-medium text-text-2">封面（可选）</span>
          {coverUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={coverUrl}
                alt="封面"
                className="h-8 w-14 rounded border border-hairline object-cover"
              />
              <button
                type="button"
                className="text-[10px] text-text-3 transition-colors hover:text-danger"
                onClick={() => setCoverUrl("")}
              >
                移除
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy !== ""}
              className="rounded border border-dashed border-hairline px-2 py-0.5 text-[10px] text-text-3 transition-colors hover:border-accent-soft hover:text-text-2 disabled:opacity-50"
              onClick={() => coverRef.current?.click()}
            >
              {busy === "cover" ? "上传中…" : "上传封面图"}
            </button>
          )}
        </div>
        {err ? <p className="mt-2 text-[11px] text-danger">{err}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy !== "" || !name.trim() || !prompt.trim()}
            className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => void save()}
          >
            {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            保存
          </button>
        </div>
        <input
          ref={reverseRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void pickImage(e.target.files?.[0], "reverse");
            e.target.value = "";
          }}
        />
        <input
          ref={coverRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void pickImage(e.target.files?.[0], "cover");
            e.target.value = "";
          }}
        />
      </div>
    </OverlayModal>
  );
}

/** 画风预设浏览：首格「我的画风」（用户自建，可新建/编辑/删除/从参考图反推，
 *  存 agent 按用户隔离）+ 内置库（juben 风格模板 87 条）：分类过滤 + 搜索，
 *  点选即套用。选中态 = 项目画风与该预设 prompt 完全一致；手改文本后高亮
 *  自动消失 */
function StylePresetList({
  projectStyle,
  onPick,
}: {
  projectStyle: string;
  onPick: (prompt: string) => void;
}) {
  const [myStyles, setMyStyles] = useState<MyStyle[] | null>(null);
  const [editing, setEditing] = useState<MyStyle | "new" | null>(null);
  const [opErr, setOpErr] = useState("");
  const [cat, setCat] = useState<string>("全部");
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await listMyStyles();
        if (!alive) return;
        setMyStyles(s);
        // 首次加载：已有自建画风则默认落在「我的画风」
        setCat((c) => (c === "全部" && s.length > 0 ? MY_STYLE_CAT : c));
      } catch {
        if (alive) setMyStyles([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const upsert = useCallback((s: MyStyle) => {
    setMyStyles((prev) => [s, ...(prev ?? []).filter((x) => x.id !== s.id)]);
  }, []);
  const remove = async (s: MyStyle) => {
    if (!window.confirm(`删除画风「${s.name}」？已应用它的项目不受影响。`)) return;
    setOpErr("");
    try {
      await deleteMyStyle(s.id);
      setMyStyles((prev) => (prev ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : "删除失败");
    }
  };

  const cats = ["全部", MY_STYLE_CAT, ...STYLE_CATEGORIES];
  const kw = q.trim();
  const mine = useMemo(
    () => (myStyles ?? []).filter((s) => !kw || s.name.includes(kw) || s.prompt.includes(kw)),
    [myStyles, kw],
  );
  const list = useMemo(() => {
    return STYLE_PRESETS.filter(
      (p) =>
        (cat === "全部" || p.category === cat) &&
        (!kw || p.name.includes(kw) || p.tagline.includes(kw) || p.prompt.includes(kw)),
    );
  }, [cat, kw]);
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1">
        {cats.map((c) => (
          <button
            key={c}
            type="button"
            className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              cat === c
                ? "bg-accent-dim font-medium text-text"
                : "text-text-3 hover:bg-surface-2 hover:text-text-2"
            }`}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索画风…"
          className="nodrag nowheel ml-auto w-24 rounded border border-hairline bg-surface-2/60 px-1.5 py-0.5 text-[10px] text-text outline-none focus:border-accent placeholder:text-text-4"
        />
      </div>
      {opErr ? <p className="mt-1.5 text-[11px] text-danger">{opErr}</p> : null}
      {cat === MY_STYLE_CAT ? (
        <div className="nowheel mt-2 grid min-h-0 flex-1 grid-cols-6 gap-2 overflow-y-auto rounded-md border border-hairline-soft bg-surface-2/40 p-2">
          {myStyles === null ? (
            <p className="col-span-6 py-6 text-center text-[11px] text-text-4">加载中…</p>
          ) : (
            <>
              <button
                key="__new"
                type="button"
                data-tip="新建画风（可从参考图反推）" aria-label="新建画风（可从参考图反推）"
                className="flex h-44 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-hairline text-text-3 transition-colors hover:border-accent-soft hover:text-text-2"
                onClick={() => setEditing("new")}
              >
                <Plus className="h-5 w-5" />
                <span className="text-[11px]">新建画风</span>
              </button>
              {myStyles.length === 0 ? (
                <p className="col-span-5 self-center py-6 text-[11px] leading-relaxed text-text-4">
                  还没有自建画风：点「新建画风」手写描述，或上传参考图让 AI
                  反推；保存后所有项目可复用
                </p>
              ) : null}
              {myStyles.length > 0 && mine.length === 0 ? (
                <p className="col-span-5 py-6 text-center text-[11px] text-text-4">
                  没有匹配的画风
                </p>
              ) : null}
              {mine.map((s) => {
                const active = projectStyle === s.prompt;
                return (
                  <div
                    key={s.id}
                    className={`group relative h-44 w-full overflow-hidden rounded-lg border transition-all ${
                      active
                        ? "border-accent ring-2 ring-accent"
                        : "border-hairline hover:border-accent-soft"
                    }`}
                  >
                    <button
                      type="button"
                      aria-label={`套用画风：${s.name}`}
                      className="absolute inset-0 h-full w-full overflow-hidden text-left"
                      onClick={() => onPick(s.prompt)}
                    >
                      {s.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.coverUrl}
                          alt={s.name}
                          loading="lazy"
                          className="absolute inset-0 h-full w-full object-cover object-top"
                        />
                      ) : (
                        <span className="absolute inset-0 bg-surface-2" />
                      )}
                      {active ? (
                        <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] font-bold text-surface-1">
                          ✓
                        </span>
                      ) : null}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-left text-[11px] font-medium text-white">
                        {s.name}
                      </span>
                    </button>
                    <span className="absolute left-1 top-1 hidden gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        data-tip="编辑" aria-label={`编辑画风：${s.name}`}
                        className="grid h-5 w-5 place-items-center rounded bg-black/55 text-white transition-colors hover:bg-black/75"
                        onClick={() => setEditing(s)}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        data-tip="删除" aria-label={`删除画风：${s.name}`}
                        className="grid h-5 w-5 place-items-center rounded bg-black/55 text-white transition-colors hover:bg-danger"
                        onClick={() => void remove(s)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      ) : (
        <div className="nowheel mt-2 grid min-h-0 flex-1 grid-cols-6 gap-2 overflow-y-auto rounded-md border border-hairline-soft bg-surface-2/40 p-2">
          {list.length === 0 ? (
            <p className="col-span-6 py-6 text-center text-[11px] text-text-4">没有匹配的画风</p>
          ) : null}
          {list.map((p) => {
            const active = projectStyle === p.prompt;
            return (
              <button
                key={p.id}
                type="button"
                data-tip={`${p.name}｜${p.tagline || p.category}`} aria-label={`${p.name}｜${p.tagline || p.category}`}
                className={`group relative h-44 w-full overflow-hidden rounded-lg border transition-all ${
                  active
                    ? "border-accent ring-2 ring-accent"
                    : "border-hairline hover:border-accent-soft"
                }`}
                onClick={() => onPick(p.prompt)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.cover}
                  alt={p.name}
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover object-top"
                />
                {active ? (
                  <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] font-bold text-surface-1">
                    ✓
                  </span>
                ) : null}
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-left text-[11px] font-medium text-white">
                  {p.name}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {editing ? (
        <StyleEditDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={upsert}
        />
      ) : null}
    </div>
  );
}

/** 底部坞：撤销/重做 + 缩放 + 素材库 + 画风 + 保存状态（对标 novanova / AIGC 的顶底栏能力） */
function BottomDock({
  onOpenAssets,
  onOpenPrompts,
  onOpenOutline,
}: {
  onOpenAssets: () => void;
  onOpenPrompts: () => void;
  onOpenOutline: () => void;
}) {
  const canUndo = useCanvasStore((s) => s.canUndoNow);
  const canRedo = useCanvasStore((s) => s.canRedoNow);
  const saveState = useCanvasStore((s) => s.saveState);
  const zoom = useCanvasStore((s) => s.viewport.zoom);
  const projectStyle = useCanvasStore((s) => s.projectStyle);
  const imagegen = useCanvasStore((s) => s.imagegen);
  // 模型目录（模块级缓存，与出图面板/PromptBar 共享一次加载）：按钮显示
  // 目录展示名，目录未到时回落模型 id
  const { models: imageModels } = useImageModels();
  const [stylePanel, setStylePanel] = useState(false);
  const [imagegenPanel, setImagegenPanel] = useState(false);
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();

  // 弹窗开着时 Esc 关闭（弹窗经 portal 挂 body，画布的全局 Esc 管不到这里）
  useEffect(() => {
    if (!stylePanel && !imagegenPanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setStylePanel(false);
      setImagegenPanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stylePanel, imagegenPanel]);

  // 画风闸拦截（出图类操作未选画风）→ 自动弹出项目画风设定弹窗
  useEffect(() => {
    const onOpen = () => setStylePanel(true);
    window.addEventListener(OPEN_STYLE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_STYLE_EVENT, onOpen);
  }, []);

  const saveLabel =
    saveState === "saving"
      ? "保存中…"
      : saveState === "saved"
        ? "已保存"
        : saveState === "offline"
          ? "离线 · 未保存"
          : null;
  return (
    <>
      <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
      <button
        type="button"
        data-tip="素材库：生成 / 上传过的图片视频音频都自动入库，点击放回画布" aria-label="素材库：生成 / 上传过的图片视频音频都自动入库，点击放回画布"
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={onOpenAssets}
        data-track="dock.assets"
      >
        <Library className="h-4 w-4" />
        素材库
      </button>
      <button
        type="button"
        data-tip="提示词常用语：选中卡片后点选，自动追加进生成输入框" aria-label="提示词常用语：选中卡片后点选，自动追加进生成输入框"
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={onOpenPrompts}
        data-track="dock.prompts"
      >
        <WandSparkles className="h-4 w-4" />
        提示词
      </button>
      <button
        type="button"
        data-tip="画布导航（按类型列出全部卡片，点击运镜定位）" aria-label="画布导航（按类型列出全部卡片，点击运镜定位）"
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={onOpenOutline}
        data-track="dock.outline"
      >
        <ListTree className="h-4 w-4" />
        导航
      </button>
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      {/* 项目画风锚点（novanova visualStyle / viedeo-workflow styleAnchor）：
          一处设定，注入所有出图与分镜生成；预设库移植自 juben 风格模板 */}
      <div className="relative">
        <button
          type="button"
          data-tip="项目画风（全局视觉风格：注入所有出图与分镜生成）" aria-label="项目画风（全局视觉风格：注入所有出图与分镜生成）"
          className={`flex h-8 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-surface-2 ${
            projectStyle ? "text-accent" : "text-text-2 hover:text-text"
          } ${stylePanel ? "bg-surface-2 text-text" : ""}`}
          onClick={() => setStylePanel((v) => !v)}
          data-track="dock.style"
        >
          <Palette className="h-4 w-4" />
          画风
          {projectStyle ? (
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          ) : null}
        </button>
      </div>
      {/* 出图模型/分辨率（项目级默认，存 meta.imagegen）：所有出图入口生效；
          按钮直显当前生效参数，不藏在一个词后面 */}
      <button
        type="button"
        data-tip={`出图设置：${imagegen.model} · ${imagegen.resolution}（全局默认，点击修改）`} aria-label={`出图设置：${imagegen.model} · ${imagegen.resolution}（全局默认，点击修改）`}
        className={`flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text ${
          imagegenPanel ? "bg-surface-2 text-text" : ""
        }`}
        onClick={() => setImagegenPanel((v) => !v)}
        data-track="dock.imagegen"
      >
        <ImageIcon className="h-4 w-4 shrink-0" />
        <span className="max-w-56 truncate">
          {imageModels?.find((m) => m.id === imagegen.model)?.label ??
            imagegen.model}{" "}
          · {imagegen.resolution}
        </span>
      </button>
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      <DockBtn disabled={!canUndo} title="撤销（⌘Z）" onClick={() => useCanvasStore.getState().undo()} data-track="dock.undo">
        <Undo2 className="h-4 w-4" />
      </DockBtn>
      <DockBtn disabled={!canRedo} title="重做（⇧⌘Z）" onClick={() => useCanvasStore.getState().redo()} data-track="dock.redo">
        <Redo2 className="h-4 w-4" />
      </DockBtn>
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      <DockBtn title="缩小（⌘-）" onClick={() => void zoomOut({ duration: 150 })} data-track="dock.zoom-out">
        <ZoomOut className="h-4 w-4" />
      </DockBtn>
      <button
        type="button"
        data-tip="点击复位 100%（⇧⌘0）" aria-label="点击复位 100%（⇧⌘0）"
        className="min-w-11 rounded-md px-1 py-1 text-center text-xs tabular-nums text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={() => void zoomTo(1, { duration: 250 })}
        data-track="dock.zoom-reset"
      >
        {Math.round(zoom * 100)}%
      </button>
      <DockBtn title="放大（⌘=）" onClick={() => void zoomIn({ duration: 150 })} data-track="dock.zoom-in">
        <ZoomInIcon className="h-4 w-4" />
      </DockBtn>
      <DockBtn title="适应视图（⌘0）" onClick={() => void fitView({ duration: 300, padding: 0.15 })} data-track="dock.fit">
        <Maximize className="h-4 w-4" />
      </DockBtn>
      <DockBtn
        title="快捷键速查（?）"
        onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT))}
        data-track="dock.shortcuts"
      >
        <Keyboard className="h-4 w-4" />
      </DockBtn>
      {saveLabel ? (
        <>
          <span className="mx-0.5 h-5 w-px bg-hairline" />
          <span
            className={`px-1.5 text-[10px] ${
              saveState === "offline" ? "text-danger" : "text-good"
            }`}
          >
            {saveLabel}
          </span>
        </>
      ) : null}
      </div>
      {stylePanel ? (
        <OverlayModal
          className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/45 p-6"
          onClick={() => setStylePanel(false)}
        >
          <div
            className="flex max-h-[88vh] w-[min(76rem,94vw)] flex-col rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-text">项目画风</p>
                <p className="mt-0.5 text-[11px] text-text-4">
                  全局视觉风格：自动注入所有资产出图、分镜生成与分镜出图。
                  点选预设即套用，也可在底部自定义描述。
                </p>
              </div>
              <button
                type="button"
                data-tip="关闭" aria-label="关闭"
                className="rounded-md p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
                onClick={() => setStylePanel(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <StylePresetList
              projectStyle={projectStyle}
              onPick={(prompt) => useCanvasStore.getState().setProjectStyle(prompt)}
            />
            <p className="mt-2 text-[11px] font-medium text-text-4">
              自定义（可直接改，或点上方预设套用）
            </p>
            <textarea
              value={projectStyle}
              onChange={(e) => useCanvasStore.getState().setProjectStyle(e.target.value)}
              placeholder="例：吉卜力水彩质感，柔和自然光，低饱和暖色"
              rows={2}
              className="nodrag nowheel mt-1 w-full resize-none rounded-md border border-hairline bg-surface-2/60 p-2 text-xs leading-relaxed text-text outline-none focus:border-accent placeholder:text-text-4"
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[11px] text-text-4">
                {projectStyle
                  ? `${projectStyle.length} 字 · 自动保存`
                  : "未设定（出图无风格约束）"}
              </span>
              <button
                type="button"
                className="rounded-md border border-hairline px-2 py-0.5 text-[11px] text-text-2 transition-colors hover:border-accent hover:text-text"
                onClick={() => setStylePanel(false)}
              >
                完成
              </button>
            </div>
          </div>
        </OverlayModal>
      ) : null}
      {imagegenPanel ? (
        <OverlayModal
          className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/45 p-6"
          onClick={() => setImagegenPanel(false)}
        >
          <div
            className="flex max-h-[88vh] w-[min(28rem,94vw)] flex-col rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-text">出图设置</p>
                <p className="mt-0.5 text-[11px] text-text-4">
                  项目级默认：分镜出图、资产出图、拆解自动出图与聊天出图均生效，随项目保存。
                </p>
              </div>
              <button
                type="button"
                data-tip="关闭" aria-label="关闭"
                className="rounded-md p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
                onClick={() => setImagegenPanel(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ImagegenSettings />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="rounded-md border border-hairline px-2 py-0.5 text-[11px] text-text-2 transition-colors hover:border-accent hover:text-text"
                onClick={() => setImagegenPanel(false)}
              >
                完成
              </button>
            </div>
          </div>
        </OverlayModal>
      ) : null}
    </>
  );
}

function DockBtn({
  title,
  disabled,
  onClick,
  children,
  ...rest
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      data-tip={title} aria-label={title}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:text-text-4 disabled:hover:bg-transparent"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 出图模型/分辨率设置（open-storyboard-canvas 的模型+参数 chip 范式，
 *  简化为项目级单一配置）：目录来自 agent 实探清单（agent/models.py），
 *  切模型时档位不支持则自动贴到该模型默认档（viedeo-workflow 联动式）。
 *  非法组合服务端也会 400 明报——双保险，前端不做静默纠正以外的兜底 */
function ImagegenSettings() {
  const imagegen = useCanvasStore((s) => s.imagegen);
  const { models, error, reload } = useImageModels();

  const current = models?.find((m) => m.id === imagegen.model) ?? null;
  const pick = (m: ImageModelOption) => {
    const resolution = m.resolutions.includes(imagegen.resolution)
      ? imagegen.resolution
      : m.default_resolution;
    useCanvasStore.getState().setImagegen({ model: m.id, resolution });
  };

  if (error)
    return (
      <div className="mt-3 rounded-md border border-danger/30 bg-surface-2/60 p-3 text-xs text-danger">
        {error}
        <button
          type="button"
          className="ml-2 underline underline-offset-2 hover:text-text"
          onClick={reload}
        >
          重试
        </button>
      </div>
    );
  if (!models)
    return <p className="mt-4 text-center text-xs text-text-4">加载模型目录…</p>;

  return (
    <div className="mt-3 space-y-3 overflow-y-auto">
      <div className="space-y-1.5">
        {models.map((m) => {
          const active = m.id === imagegen.model;
          return (
            <button
              key={m.id}
              type="button"
              className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-accent bg-accent-dim"
                  : "border-hairline hover:border-text-4"
              }`}
              onClick={() => pick(m)}
            >
              <span>
                <span className="flex items-center gap-1.5 text-xs font-medium text-text">
                  {m.label}
                  {m.recommended ? (
                    <span className="rounded bg-accent/15 px-1 py-px text-[9px] text-accent">
                      推荐
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[10px] text-text-4">{m.tag}</span>
              </span>
              {active ? <span className="h-2 w-2 shrink-0 rounded-full bg-accent" /> : null}
            </button>
          );
        })}
      </div>
      <div>
        <p className="text-[11px] font-medium text-text-4">清晰度</p>
        <div className="mt-1 flex gap-1">
          {["1K", "2K", "4K"].map((r) => {
            const supported = current?.resolutions.includes(r) ?? true;
            return (
              <button
                key={r}
                type="button"
                disabled={!supported}
                data-tip={supported ? undefined : `${current?.label ?? "该模型"}不支持 ${r} 档`} aria-label={supported ? undefined : `${current?.label ?? "该模型"}不支持 ${r} 档`}
                className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                  imagegen.resolution === r
                    ? "border-accent bg-accent-dim text-text"
                    : supported
                      ? "border-hairline text-text-2 hover:text-text"
                      : "cursor-not-allowed border-hairline text-text-4 opacity-40"
                }`}
                onClick={() => useCanvasStore.getState().setImagegen({ resolution: r })}
              >
                {r}
              </button>
            );
          })}
        </div>
        {!current ? (
          <p className="mt-1 text-[10px] text-danger">
            当前模型 {imagegen.model} 不在目录中，选一个上面列出的模型即可纠正
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 框选安全网：RF 的 onPointerCancel 只释放指针捕获、不清 userSelectionRect
 * （12.11.5 仍如此，上游未修）——浏览器把按压手势转成 pointercancel 或
 * pointerup 被漏掉时，选框会永久卡住（矩形跟手走、点击清不掉）。
 * 复位必须延迟到事件落定之后：RF 自己的 onPointerUp 是同步清理，且其中
 * "简单点击 → 清空选中"的分支依赖 rect 仍存在——抢先清掉会把点空白取消
 * 选中弄坏。setTimeout(0) 后 rect 仍在 = RF 没接住 = 真卡死，才复位。
 */
function SelectionGuard() {
  const store = useStoreApi();
  useEffect(() => {
    const resetIfStuck = () => {
      if (store.getState().userSelectionRect) {
        store.setState({ userSelectionActive: false, userSelectionRect: null });
      }
    };
    const deferredReset = () => {
      setTimeout(resetIfStuck, 0);
    };
    const onUp = (e: PointerEvent | MouseEvent) => {
      if (e.type === "pointercancel" || e.button === 0) deferredReset();
    };
    // mouseup 兜底：三指拖移等合成手势可能只发 mouse 系事件
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    // 失焦没有后续事件，立即复位
    window.addEventListener("blur", resetIfStuck);
    return () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("blur", resetIfStuck);
    };
  }, [store]);
  return null;
}

/** 拖动对齐辅助线：流坐标 → 容器坐标渲染（数据来自 store.onNodesChange 的吸附计算） */
function GuideOverlay() {
  const guides = useCanvasStore((s) => s.alignGuides);
  const vp = useCanvasStore((s) => s.viewport);
  if (guides.x.length === 0 && guides.y.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {guides.x.map((x) => (
        <div
          key={`x${x}`}
          className="absolute top-0 bottom-0 w-px bg-accent-2"
          style={{ left: vp.x + x * vp.zoom }}
        />
      ))}
      {guides.y.map((y) => (
        <div
          key={`y${y}`}
          className="absolute left-0 right-0 h-px bg-accent-2"
          style={{ top: vp.y + y * vp.zoom }}
        />
      ))}
    </div>
  );
}

/** 多选浮动工具条：跟随选区包围盒顶部居中（对标 novanova / 影策的 selection toolbar） */
const ALIGN_MENU: {
  label: string;
  min: number;
  run: (ids: string[]) => void;
}[] = [
  { label: "左对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "left") },
  { label: "水平居中", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "hcenter") },
  { label: "右对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "right") },
  { label: "顶对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "top") },
  { label: "垂直居中", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "vcenter") },
  { label: "底对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "bottom") },
  { label: "水平等距", min: 3, run: (ids) => useCanvasStore.getState().distributeNodes(ids, "h") },
  { label: "垂直等距", min: 3, run: (ids) => useCanvasStore.getState().distributeNodes(ids, "v") },
];

function SelBtn({
  danger,
  onClick,
  children,
}: {
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`nodrag rounded-md px-2 py-1 text-xs transition-colors ${
        danger ? "text-danger hover:bg-danger/10" : "text-text-2 hover:bg-surface-2 hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SelectionToolbar() {
  const nodes = useCanvasStore((s) => s.nodes);
  // 订阅视口：平移缩放后重算锚点（画布坐标 → 容器坐标 = vp + flow*zoom）
  const vp = useCanvasStore((s) => s.viewport);
  const [alignOpen, setAlignOpen] = useState(false);
  // 多选等比缩放（轻量版：宽度与水平间距等比；高度只在卡上已显式设置时跟随）
  const scaleRef = useRef<{
    startX: number;
    baseW: number;
    boxes: ReturnType<typeof selectionBoxes>;
    anchor: { x: number; y: number };
  } | null>(null);
  const sel = nodes.filter((n) => n.selected);
  if (sel.length < 2) return null;
  const ids = sel.map((n) => n.id);
  const boxes = selectionBoxes(nodes, ids);
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const anchor = {
    x: vp.x + ((minX + maxX) / 2) * vp.zoom,
    y: vp.y + minY * vp.zoom,
  };
  const seCorner = { x: vp.x + maxX * vp.zoom, y: vp.y + maxY * vp.zoom };

  const onScaleStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    useCanvasStore.getState().commitHistory();
    scaleRef.current = {
      startX: e.clientX,
      baseW: (maxX - minX) * vp.zoom,
      boxes: selectionBoxes(useCanvasStore.getState().nodes, ids),
      anchor: { x: minX, y: minY },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onScaleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const base = scaleRef.current;
    if (!base) return;
    const ratio = Math.min(3, Math.max(0.35, (base.baseW + e.clientX - base.startX) / base.baseW));
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) => {
        const b = base.boxes.find((x) => x.id === n.id);
        if (!b) return n;
        const w = Math.max(160, Math.round(b.w * ratio));
        const h = Math.max(120, Math.round(b.h * ratio));
        const absX = Math.round(base.anchor.x + (b.x - base.anchor.x) * ratio);
        const absY = Math.round(base.anchor.y + (b.y - base.anchor.y) * ratio);
        // 顶层 w/h 与 style 双写：xyflow 渲染/回写走顶层，style 留作默认尺寸语义
        return {
          ...n,
          position: { x: absX - b.dx, y: absY - b.dy },
          width: w,
          height: h,
          style: { ...n.style, width: w, height: h },
        };
      }),
    }));
  };

  return (
    <>
      <div
        className="absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
        style={{ left: anchor.x, top: anchor.y - 10 }}
      >
        <span className="px-1.5 text-[10px] text-text-4">已选 {sel.length}</span>
        <SelBtn onClick={() => useCanvasStore.getState().copySelection()}>复制</SelBtn>
        <div className="relative">
          <SelBtn onClick={() => setAlignOpen((o) => !o)}>对齐 ▾</SelBtn>
          {alignOpen ? (
            <>
              <div className="fixed inset-0 z-0" onClick={() => setAlignOpen(false)} />
              <div className="absolute left-0 top-full z-10 mt-1 flex w-24 flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
                {ALIGN_MENU.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    disabled={sel.length < a.min}
                    className="rounded-md px-2 py-1 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:text-text-4 disabled:hover:bg-transparent"
                    onClick={() => {
                      setAlignOpen(false);
                      a.run(ids);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <SelBtn onClick={() => useCanvasStore.getState().groupNodes(ids)}>成组</SelBtn>
        <SelBtn onClick={() => useCanvasStore.getState().tidyNodes(ids)}>整理</SelBtn>
        <SelBtn danger onClick={() => useCanvasStore.getState().deleteNodes(ids)}>
          删除
        </SelBtn>
      </div>
      {/* 选区右下角：等比缩放手柄 */}
      <div
        title="拖动等比缩放选中卡片"
        className="absolute z-10 h-3 w-3 cursor-nwse-resize rounded-sm border-[1.5px] border-accent bg-surface-1 shadow-sm"
        style={{ left: seCorner.x - 6, top: seCorner.y - 6 }}
        onPointerDown={onScaleStart}
        onPointerMove={onScaleMove}
        onPointerUp={() => {
          scaleRef.current = null;
        }}
      />
    </>
  );
}

function EmptyState() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
      {/* 三行短句各占一行（max-w 放宽到 md 保证不折行），避免长句在窄容器里
          断出「直/接拖进来」这类破碎换行 */}
      <div className="max-w-md text-center">
        <h2 className="font-editorial text-xl font-medium text-text-2">
          空白画布
        </h2>
        <div className="mt-2 space-y-1 text-sm leading-relaxed text-text-3">
          <p>双击空白建卡，或直接拖入图片 / 视频 / 文本文件</p>
          <p>工具条 / 右键菜单建卡连线，输入条 @ 引用角色直接生成</p>
          <p>也可以让右侧助手帮你搭起故事板</p>
        </div>
      </div>
    </div>
  );
}

/** 自定义边类型：覆盖内置 default（存量边无 type 字段正好像中）。
 *  必须放组件外保持引用稳定，否则 xyflow 每帧重建边组件 */
const edgeTypes = { default: DeletableEdge };

export default function CanvasView() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const addNode = useCanvasStore((s) => s.addNode);
  const viewport = useCanvasStore((s) => s.viewport);
  const clipboardCount = useCanvasStore((s) => s.clipboardCount);
  const canUndo = useCanvasStore((s) => s.canUndoNow);
  const canRedo = useCanvasStore((s) => s.canRedoNow);

  // 画布视图偏好（localStorage，设备本地）：小地图 / 网格吸附 / 连线显隐
  const [minimapVisible] = useCanvasPref("minimap");
  const [snapEnabled] = useCanvasPref("snap");
  const [edgesVisible] = useCanvasPref("edges");

  // 视口双向同步：agent 的 set_viewport / 项目装载 → 画布动画跟随；
  // 用户平移缩放 → 回写 store（供持久化与 agent 感知）。
  // ref 按值比较防回环：程序化 setViewport 结束也会触发 onMoveEnd。
  const { screenToFlowPosition, setViewport: setRfViewport, fitView } =
    useReactFlow();
  // dev 测试钩子：headless E2E 恢复视口用（onlyRenderVisibleElements 会把
  // 视口外节点卸载，聚焦平移后测试需要能把目标卡摆回视野）；
  // __wsCanvasStore 供编辑回归直接驱动 store（外部改值回写通道）
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __wsSetViewport?: unknown }).__wsSetViewport =
        setRfViewport;
      (window as unknown as { __wsCanvasStore?: unknown }).__wsCanvasStore =
        useCanvasStore;
      (window as unknown as { __summarizeCanvas?: unknown }).__summarizeCanvas = (
        selected: string[] = [],
      ) => {
        const st = useCanvasStore.getState();
        return summarizeCanvas(st.nodes, st.edges, selected);
      };
    }
  }, [setRfViewport]);
  const lastSyncedVp = useRef<Viewport>(viewport);
  useEffect(() => {
    if (vpEq(viewport, lastSyncedVp.current)) return;
    lastSyncedVp.current = viewport;
    void setRfViewport(viewport, { duration: 300 });
  }, [viewport, setRfViewport]);
  const onMoveEnd = useCallback<OnMoveEnd>((_event, vp) => {
    if (vpEq(vp, lastSyncedVp.current)) return;
    lastSyncedVp.current = vp;
    useCanvasStore.getState().setViewport(vp);
  }, []);

  // 背景点阵（对标 open-ai-canvas 的 LOD 网格）：xyflow <Background> 画在画布
  // 坐标系，缩小时间距被压缩成屏幕级摩尔纹（点糊成十字，用户反馈"又密又丑"）。
  // 改为屏幕坐标自绘：点距 = max(32×zoom, 32)px 触底不压缩（32 = 2×吸附格），
  // 点半径恒定屏幕像素、深缩换小档；backgroundPosition 取 viewport 余数——
  // 点阵随平移移动（锚定画布空间）但尺寸密度恒定。逐帧写 style 不经 React。
  const gridRef = useRef<HTMLDivElement | null>(null);
  const paintGrid = useCallback((vp: Viewport) => {
    const el = gridRef.current;
    if (!el) return;
    const gap = Math.max(32 * vp.zoom, 32);
    const dot = vp.zoom < 0.12 ? 0.6 : 0.8;
    el.style.backgroundSize = `${gap}px ${gap}px`;
    el.style.backgroundPosition = `${((vp.x % gap) + gap) % gap}px ${
      ((vp.y % gap) + gap) % gap
    }px`;
    el.style.backgroundImage = `radial-gradient(circle, var(--color-hairline-strong) ${dot}px, transparent ${dot + 0.4}px)`;
  }, []);
  // 程序化视口（项目装载 / agent set_viewport）的动画帧也走 onMove，挂载首帧在此补
  useEffect(() => {
    paintGrid(viewport);
  }, [paintGrid, viewport]);
  const onMove = useCallback<OnMove>((_event, vp) => paintGrid(vp), [paintGrid]);

  // fitView prop 在 12.11 不是"只看挂载一次"：StoreUpdater 监听它，prop 值
  // 一旦翻转就 fitViewQueued=true 重新执行 fit——空画布建第一张卡时 false→true
  // 会把单卡怼满视口、放大顶到 maxZoom（400%）。所以挂载时取值后冻结，
  // 运行期节点数变化不再触碰这个 prop
  const [fitOnMount] = useState(nodes.length > 0);

  // 滚轮语义对标 Figma，不做鼠标/触控板设备判定（ReactFlow props 处：
  // 滚轮/双指=平移、⌘+滚/捏合=缩放，全走 xyflow 原生分支）。曾试过按
  // deltaY 量级猜设备再切 zoomOnScroll/panOnScroll——触控板快扫/惯性
  // 步进会落进"鼠标"窗口，平移中途误缩放，已删。
  const onWheelCapture = useCallback(
    (e: React.WheelEvent) => {
      // nowheel 动态化：xyflow 对 .nowheel 元素整体跳过滚轮，但我们把它贴在
      // 大量未必可滚动的容器上（文本区/行列表/选择器），导致节点上无法平移。
      // 这里在 capture 阶段先行判定——目标链上有任一 nowheel 元素「真的可
      // 滚动」才滚内容；否则现场摘类（setTimeout 还原），赶在 xyflow 的
      // closest('.nowheel') 判定之前放行平移
      let el = e.target as HTMLElement | null;
      const nws: HTMLElement[] = [];
      while (el && !el.classList.contains("react-flow")) {
        if (el.classList.contains("nowheel")) nws.push(el);
        el = el.parentElement;
      }
      if (nws.length > 0) {
        const anyScrollable = nws.some(
          (nw) =>
            nw.scrollHeight > nw.clientHeight ||
            nw.scrollWidth > nw.clientWidth,
        );
        if (anyScrollable) return;
        for (const nw of nws) {
          nw.classList.remove("nowheel");
          setTimeout(() => nw.classList.add("nowheel"), 0);
        }
      }
    },
    [],
  );

  // Alt+拖拽复制（Figma 手势）：拖动开始时原位克隆选区，后续拖动帧在 store
  // 里改道到副本——原件留在原地，副本跟随指针走
  const onNodeDragStart = useCallback<OnNodeDrag<WingNode>>((event, node) => {
    if (event.altKey) {
      useCanvasStore.getState().beginAltDragClone(node.id);
    }
  }, []);
  const onNodeDragStop = useCallback(() => {
    useCanvasStore.getState().endAltDrag();
  }, []);

  // 键盘删除（deleteKeyCode）走 RF 的 deleteElements：在 remove 变更发出前
  // 提交快照，让 Backspace 删卡/删边也可撤销（右键菜单删除走 store.deleteNodes
  // 自带快照；节点+边同删时这里只进一次撤销步）
  const onBeforeDelete = useCallback<
    OnBeforeDelete<WingNode, WingEdge>
  >(async ({ nodes: delNodes, edges: delEdges }) => {
    if (delNodes.length > 0 || delEdges.length > 0) {
      useCanvasStore.getState().commitHistory();
    }
    return true;
  }, []);

  // 生成中的连线流动动画：目标节点 loading 时给边标 animated（样式在 globals.css）；
  // 同时按两端节点类型推导关系语义标签（出演/出图/拆解…）
  const loadingKey = useCanvasStore((s) =>
    s.nodes
      .filter((n) => n.data.status === "loading")
      .map((n) => n.id)
      .join(","),
  );
  // 相邻高亮（open-ai-canvas related 态）：hover/选中单卡时点亮它的连线与邻居
  const [hoverId, setHoverId] = useState<string | null>(null);
  const selectedKey = nodes
    .filter((n) => n.selected)
    .map((n) => n.id)
    .join(",");
  const related = useMemo(() => {
    const selected = selectedKey ? selectedKey.split(",") : [];
    return hoverId ?? (selected.length === 1 ? selected[0] : null);
  }, [hoverId, selectedKey]);
  const onNodeHover = useCallback(
    (_: React.MouseEvent, node: WingNode) => setHoverId(node.id),
    [],
  );
  const onNodeHoverEnd = useCallback(() => setHoverId(null), []);

  const displayEdges = useMemo(() => {
    const loading = new Set(loadingKey ? loadingKey.split(",") : []);
    // 折叠分组的边重接（对标 open-ai-canvas frame 折叠）：隐藏子卡的连线
    // 显示层改挂到组节点，展开自动还原（纯显示转换，不动数据）
    const hiddenToGroup = new Map<string, string>();
    for (const n of nodes) {
      if (!n.hidden || !n.parentId) continue;
      const parent = nodes.find((x) => x.id === n.parentId);
      if (parent?.data.collapsed) hiddenToGroup.set(n.id, n.parentId);
    }
    const wire = (id: string) => hiddenToGroup.get(id) ?? id;
    return edges.map((e) => {
      const src = wire(e.source);
      const tgt = wire(e.target);
      return {
        ...e,
        source: src,
        target: tgt,
        ...(loading.has(e.target) ? { animated: true } : {}),
        ...(related
          ? src === related || tgt === related
            ? { className: "ws-edge-related" }
            : {}
          : {}),
      };
    });
  }, [edges, loadingKey, nodes, related]);

  const displayNodes = useMemo(() => {
    if (!related) {
      const anyLocked = nodes.some((n) => n.data.locked);
      if (!anyLocked) return nodes;
      return nodes.map((n) => (n.data.locked ? { ...n, draggable: false } : n));
    }
    const relatedIds = new Set<string>([related]);
    for (const e of edges) {
      if (e.source === related) relatedIds.add(e.target);
      if (e.target === related) relatedIds.add(e.source);
    }
    return nodes.map((n) =>
      relatedIds.has(n.id)
        ? { ...n, className: "ws-node-related", ...(n.data.locked ? { draggable: false } : {}) }
        : { ...n, className: undefined, ...(n.data.locked ? { draggable: false } : {}) },
    );
  }, [nodes, edges, related]);

  // 连接校验：自环与重复边直接拒绝
  const isValidConnection = useCallback<IsValidConnection>((conn) => {
    if (conn.source === conn.target) return false;
    return !useCanvasStore
      .getState()
      .edges.some((e) => e.source === conn.source && e.target === conn.target);
  }, []);

  // 重接线：拖动已有连线端点换到新节点
  const onReconnect = useCallback<OnReconnect>((oldEdge, newConnection) => {
    useCanvasStore.getState().reconnectEdge(oldEdge.id, newConnection);
  }, []);

  // @引用光环：单选生成卡时高亮它引用的卡片（refIds 由 PromptBar 生成时写入）
  useEffect(() => {
    const sel = nodes.filter((n) => n.selected);
    const refs =
      sel.length === 1 && Array.isArray(sel[0].data.refIds)
        ? (sel[0].data.refIds as string[])
        : [];
    if (refs.join(",") === useCanvasStore.getState().haloIds.join(",")) return;
    useCanvasStore.getState().setHaloIds(refs);
  }, [nodes]);

  // agent 建卡 / "+" 建下游卡 → 视口聚焦到新节点（平移+缩放到可见）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocusNodes = (e: Event) => {
      const ids = (e as CustomEvent<FocusNodesDetail>).detail?.ids ?? [];
      if (ids.length === 0) return;
      // 等新节点渲染进 React Flow 后再运镜
      timer = setTimeout(() => {
        void fitView({
          nodes: ids.map((id) => ({ id })),
          duration: 450,
          padding: 0.25,
          maxZoom: 1,
        });
      }, 60);
    };
    window.addEventListener(FOCUS_NODES_EVENT, onFocusNodes);
    return () => {
      window.removeEventListener(FOCUS_NODES_EVENT, onFocusNodes);
      if (timer) clearTimeout(timer);
    };
  }, [fitView]);

  // 连线拖到空白处 → 弹建卡菜单（选中类型后建卡并自动连线）
  const [pendingLink, setPendingLink] = useState<{
    x: number;
    y: number;
    sourceId: string;
  } | null>(null);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      // 有效连线交给 onConnect；落在节点上的无效连接（自环/重复）静默取消，
      // 只有落到空白处才弹"建卡并连线"菜单
      if (connectionState.isValid || connectionState.toNode) return;
      const sourceId = connectionState.fromNode?.id;
      if (!sourceId) return;
      const pos =
        "clientX" in event
          ? { x: event.clientX, y: event.clientY }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      setPendingLink({ ...pos, sourceId });
    },
    [],
  );
  const createAt = useCallback(
    (type: WingNodeType) => {
      if (!pendingLink) return;
      const flow = screenToFlowPosition({
        x: pendingLink.x,
        y: pendingLink.y,
      });
      const id = addNode({
        position: { x: flow.x - 110, y: flow.y - 40 },
        data: { nodeType: type, title: "", body: "" },
      });
      useCanvasStore.getState().connect({
        source: pendingLink.sourceId,
        target: id,
      });
      setPendingLink(null);
    },
    [pendingLink, addNode, screenToFlowPosition],
  );

  const linkMenuTypes: WingNodeType[] = [
    "note",
    "image",
    "video",
    "character",
  ];

  // ---------- 右键菜单（空白 / 节点 / 多选 / 连线） ----------
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtx = useCallback(() => setCtxMenu(null), []);

  // 素材库 / 提示词库 / 大纲面板（底部坞 / 右键空白 打开，三者互斥）
  const [trayOpen, setTrayOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  // 右键菜单触发的导演台 / 节点信息弹窗
  const [directorNode, setDirectorNode] = useState<WingNode | null>(null);
  const [infoNode, setInfoNode] = useState<WingNode | null>(null);
  // 卡片悬浮工具条「节点信息」→ 打开信息弹窗（工具条在 nodes.tsx，经事件总线）
  useEffect(() => {
    const onNodeInfo = (e: Event) => {
      const nid = (e as CustomEvent<NodeInfoDetail>).detail?.nodeId;
      const n = useCanvasStore.getState().nodes.find((x) => x.id === nid);
      if (n) setInfoNode(n);
    };
    window.addEventListener(NODE_INFO_EVENT, onNodeInfo);
    return () => window.removeEventListener(NODE_INFO_EVENT, onNodeInfo);
  }, []);

  useEffect(() => {
    if (!ctxMenu && !pendingLink) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeCtx();
      setPendingLink(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu, closeCtx, pendingLink]);

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent<Element> | MouseEvent) => {
      event.preventDefault();
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setCtxMenu({
        kind: "pane",
        x: event.clientX,
        y: event.clientY,
        fx: flow.x,
        fy: flow.y,
        sub: null,
      });
    },
    [screenToFlowPosition],
  );

  // 双击空白 → "添加节点"选择器（不预判用户要建哪种卡，对标 reference 的
  // 双击菜单）。这个 prop 落在 wrapper div 上，卡片留白/小地图/底部坞/输入条
  // 选词等双击都会冒泡上来，正向判定：目标必须在 pane 内且不在可交互元素上。
  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".react-flow__pane")) return;
      if (
        target.closest(
          ".react-flow__node, .react-flow__minimap, .react-flow__edge, .react-flow__controls, button, input, textarea, select, [contenteditable]",
        )
      ) {
        return;
      }
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setCtxMenu({
        kind: "add",
        x: event.clientX,
        y: event.clientY,
        fx: flow.x,
        fy: flow.y,
      });
    },
    [screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback<NodeMouseHandler<WingNode>>(
    (event, node) => {
      event.preventDefault();
      const selected = nodes.filter((n) => n.selected);
      if (node.selected && selected.length > 1) {
        setCtxMenu({
          kind: "selection",
          x: event.clientX,
          y: event.clientY,
          ids: selected.map((n) => n.id),
        });
        return;
      }
      setCtxMenu({ kind: "node", x: event.clientX, y: event.clientY, id: node.id });
    },
    [nodes],
  );

  // Tab 键（CanvasShortcuts）→ 视口中央弹「添加节点」选择器，与双击空白同菜单
  useEffect(() => {
    const onOpenAdd = () => {
      const x = window.innerWidth / 2;
      const y = window.innerHeight / 2;
      const flow = screenToFlowPosition({ x, y });
      setCtxMenu({ kind: "add", x, y, fx: flow.x, fy: flow.y });
    };
    window.addEventListener(OPEN_ADD_MENU_EVENT, onOpenAdd);
    return () => window.removeEventListener(OPEN_ADD_MENU_EVENT, onOpenAdd);
  }, [screenToFlowPosition]);

  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent<Element>, selNodes: WingNode[]) => {
      event.preventDefault();
      setCtxMenu({
        kind: "selection",
        x: event.clientX,
        y: event.clientY,
        ids: selNodes.map((n) => n.id),
      });
    },
    [],
  );

  const onEdgeContextMenu = useCallback<EdgeMouseHandler>(
    (event, edge) => {
      event.preventDefault();
      setCtxMenu({ kind: "edge", x: event.clientX, y: event.clientY, id: edge.id });
    },
    [],
  );

  /** 双击选择器 / 右键"添加节点"共用：在菜单落点建卡 */
  const addAtCtx = useCallback(
    (type: WingNodeType) => {
      if (!ctxMenu || (ctxMenu.kind !== "pane" && ctxMenu.kind !== "add"))
        return;
      const id = addNode({
        position: { x: ctxMenu.fx - 110, y: ctxMenu.fy - 40 },
        data: { nodeType: type, title: "", body: "" },
      });
      setCtxMenu(null);
      // 常驻编辑卡：建卡即把光标送入正文（文档型卡片零门槛开写）
      dispatchFocusEdit(id);
    },
    [ctxMenu, addNode],
  );

  // 右键"上传"：隐藏 input 触发系统选文件；落点先存 ref（系统对话框异步
  // 返回时菜单早已关闭，state 拿不到）
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAtRef = useRef({ x: 0, y: 0 });
  const openUploadPicker = useCallback(() => {
    // 双击"添加节点"菜单（kind=add）与右键菜单（kind=pane）都带落点坐标
    const menu = ctxMenu;
    if (!menu || (menu.kind !== "pane" && menu.kind !== "add")) return;
    uploadAtRef.current = { x: menu.fx, y: menu.fy };
    setCtxMenu(null);
    fileInputRef.current?.click();
  }, [ctxMenu]);
  const onUploadPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = [...(e.target.files ?? [])];
      e.target.value = "";
      if (files.length === 0) return;
      void importDroppedFiles(files, uploadAtRef.current);
    },
    [],
  );

  /** 复制指定节点：右键的节点可能不在选区内，先选中再复制 */
  const copyNodes = useCallback((ids: string[]) => {
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })),
    }));
    useCanvasStore.getState().copySelection();
  }, []);

  const deleteEdge = useCallback((id: string) => {
    useCanvasStore.getState().commitHistory();
    useCanvasStore.setState((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
    }));
  }, []);

  // ---------- 拖拽文件导入 / 工具条拖入建卡 ----------
  const onDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  // 桌面文件悬停时的全画布接收态（对标 open-ai-canvas dropzone；enter/leave 计数防子元素抖动）
  const [dropHover, setDropHover] = useState(false);
  const dragDepth = useRef(0);
  const onWrapperDragEnter = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setDropHover(true);
  }, []);
  const onWrapperDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropHover(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      dragDepth.current = 0;
      setDropHover(false);
      if (!event.dataTransfer.files?.length) return;
      event.preventDefault();
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      void importDroppedFiles([...event.dataTransfer.files], flow);
    },
    [screenToFlowPosition],
  );

  return (
    <div
      className="relative h-full w-full"
      onWheelCapture={onWheelCapture}
      onDragEnter={onWrapperDragEnter}
      onDragLeave={onWrapperDragLeave}
    >
      {/* 背景点阵垫底：ReactFlow 透明底，此层透出 */}
      <div ref={gridRef} className="pointer-events-none absolute inset-0" />
      {dropHover ? (
        <div className="ws-dropzone">
          <div className="rounded-lg bg-surface-1 px-4 py-2 text-xs font-medium text-text shadow-lg">
            松手导入素材（图片 / 视频 / 音频 / 文本）
          </div>
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.txt,.md,.markdown"
        className="hidden"
        onChange={onUploadPicked}
      />
      {nodes.length === 0 ? <EmptyState /> : null}
      <SelectionToolbar />
      <NodeInputPanel />
      <GuideOverlay />
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        // 拖线中的连线样式：强调色虚线（落点 handle 高亮见 globals.css）
        connectionLineStyle={{
          stroke: "var(--color-accent)",
          strokeWidth: 2.5,
          strokeDasharray: "6 6",
        }}
        onReconnect={onReconnect}
        edgesReconnectable
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onBeforeDelete={onBeforeDelete}
        onPaneContextMenu={onPaneContextMenu}
        onNodeMouseEnter={onNodeHover}
        onNodeMouseLeave={onNodeHoverEnd}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDoubleClick={onDoubleClick}
        // fitOnMount 挂载时取值后冻结（声明处有说明）：挂载时画布已有内容
        // （重挂载/热更新）则适配视图，否则走 defaultViewport；装载项目后的
        // 视口由 store.viewport 同步效应接管
        defaultViewport={{ x: 40, y: 40, zoom: 0.9 }}
        fitView={fitOnMount}
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={4}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode={["Shift", "Meta"]}
        // 拖边端点重接线的命中半径（默认 10 太小不好抓）
        reconnectRadius={24}
        // 连线永远在卡片下层。xyflow 默认 zIndexMode="basic" 会把边 z 算成
        // 「边自身 z + max(两端节点 z)」——两端置顶过的卡(z≥1)的连线会压过
        // 全部普通卡(z=0)横穿卡面；manual 模式边 z 恒取自身值(0)。
        // 选中/拖拽中卡片的上浮是节点自身层级（1000/1001），不受影响。
        zIndexMode="manual"
        // 左拖=框选的前提：panOnDrag 必须非 true（xyflow 12.11 守卫），中键=平移；
        // 右键拖不启用——macOS 的 contextmenu 在 mousedown 即触发，右拖平移会和
        // 右键菜单打架。平移途径：双指滚动 / Space+拖 / 中键拖。
        panOnDrag={[1]}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        // 1px 阈值区分点击与拖动，避免单击手抖污染撤销历史
        nodeDragThreshold={1}
        // 滚轮=平移（panOnScrollSpeed=1 物理跟速；默认 0.5 会显拖沓）。
        // ⌘+滚=缩放：zoomActivationKeyCode 默认 mac=Meta，按住时 xyflow 把
        // wheel 处理器从平移重绑回 d3 缩放；捏合走 panOnScroll 处理器的
        // ctrlKey 分支（zoomOnPinch 默认开）
        zoomOnScroll={false}
        panOnScroll
        panOnScrollSpeed={1}
        zoomOnDoubleClick={false}
        // 手柄点击归加号菜单（nodes.tsx 按位移区分点击/拖拽），连线只认
        // 拖拽。默认 connectOnClick=true 会让点加号在开菜单的同时悄悄进入
        // "点击连线"流程（再点别卡手柄凭空出线），还冒泡选中卡片弹工具条
        connectOnClick={false}
        snapToGrid={snapEnabled}
        snapGrid={[16, 16]}
        onlyRenderVisibleElements
        className={`bg-transparent${edgesVisible ? "" : " ws-edges-hidden"}`}
      >
        {minimapVisible ? (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            // 纸感主题：默认白底在米黄画布上是突兀的白块
            bgColor="var(--color-surface-2)"
            maskColor="color-mix(in oklab, var(--color-surface-1) 72%, transparent)"
            style={{
              borderRadius: 10,
              border: "1px solid var(--color-hairline)",
              boxShadow: "0 1px 3px oklch(0 0 0 / 0.06)",
            }}
            nodeColor={(n) => NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.dot ?? "var(--color-warm)"}
            nodeStrokeColor="var(--color-hairline)"
          />
        ) : null}
        <div data-canvas-header className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
          <button
            type="button"
            data-tip="添加节点（Tab / 双击空白同）" aria-label="添加节点"
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-hairline bg-surface-1 text-text-2 shadow-sm transition-colors hover:bg-surface-2 hover:text-text"
            data-track="dock.add-node"
            onClick={() =>
              window.dispatchEvent(new CustomEvent(OPEN_ADD_MENU_EVENT))
            }
          >
            <Plus className="h-4 w-4" />
          </button>
          <NodeSearch />
          <CanvasSettings />
        </div>
        <BottomDock
          onOpenAssets={() => {
            setTrayOpen(true);
            setPromptsOpen(false);
            setOutlineOpen(false);
          }}
          onOpenPrompts={() => {
            setPromptsOpen(true);
            setTrayOpen(false);
            setOutlineOpen(false);
          }}
          onOpenOutline={() => {
            setOutlineOpen(true);
            setTrayOpen(false);
            setPromptsOpen(false);
          }}
        />
        <SelectionGuard />
        <CanvasShortcuts />
        <ShortcutsModal />
        <ServiceBanner />
        <OfflineIndicator />
        <AssetAutoRecorder />
      </ReactFlow>
      {trayOpen ? <AssetTray onClose={() => setTrayOpen(false)} /> : null}
      {promptsOpen ? <PromptLibraryPanel onClose={() => setPromptsOpen(false)} /> : null}
      {outlineOpen ? <OutlinePanel onClose={() => setOutlineOpen(false)} /> : null}
      <ImageToolDialogs />
      {directorNode ? (
        <DirectorPanel node={directorNode} onClose={() => setDirectorNode(null)} />
      ) : null}
      {infoNode ? (
        <NodeInfoModal node={infoNode} onClose={() => setInfoNode(null)} />
      ) : null}
      {pendingLink ? (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setPendingLink(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPendingLink(null);
            }}
          />
          <div
            className="fixed z-30 flex flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
            style={{
              left: Math.min(pendingLink.x + 8, window.innerWidth - 140),
              top: Math.min(pendingLink.y + 8, window.innerHeight - 220),
            }}
          >
            <p className="px-2 py-1 text-[10px] text-text-4">建卡并连线</p>
            {linkMenuTypes.map((t) => (
              <button
                key={t}
                type="button"
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-2 hover:bg-surface-2 hover:text-text"
                onClick={() => createAt(t)}
              >
                <span
                  className="ws-card-dot"
                  style={{ background: NODE_META[t].dot }}
                />
                {NODE_META[t].label}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {ctxMenu ? (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={closeCtx}
            onContextMenu={(e) => {
              e.preventDefault();
              closeCtx();
            }}
          />
          <div
            className="fixed z-30 flex flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
            style={{
              left: Math.min(ctxMenu.x + 8, window.innerWidth - 180),
              top: Math.min(ctxMenu.y + 8, window.innerHeight - 300),
            }}
          >
            {ctxMenu.kind === "add" ? (
              <NodeAddMenu
                onPick={addAtCtx}
                onUpload={() => {
                  closeCtx();
                  openUploadPicker();
                }}
                onTray={() => {
                  setTrayOpen(true);
                  closeCtx();
                }}
              />
            ) : ctxMenu.kind === "pane" && ctxMenu.sub === "add" ? (
              <NodeAddMenu
                onPick={addAtCtx}
                onUpload={() => {
                  closeCtx();
                  openUploadPicker();
                }}
                onTray={() => {
                  setTrayOpen(true);
                  closeCtx();
                }}
              />
            ) : ctxMenu.kind === "pane" ? (
              <>
                <CtxItem
                  label="添加节点"
                  chevron
                  onClick={() => setCtxMenu({ ...ctxMenu, sub: "add" })}
                />
                <CtxItem label="上传" onClick={openUploadPicker} />
                <CtxItem
                  label="素材库…"
                  onClick={() => {
                    setTrayOpen(true);
                    closeCtx();
                  }}
                />
                <CtxSep />
                <CtxItem
                  label="撤销"
                  shortcut="⌘Z"
                  disabled={!canUndo}
                  onClick={() => {
                    useCanvasStore.getState().undo();
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="重做"
                  shortcut="⇧⌘Z"
                  disabled={!canRedo}
                  onClick={() => {
                    useCanvasStore.getState().redo();
                    closeCtx();
                  }}
                />
                <CtxSep />
                <CtxItem
                  label="粘贴"
                  shortcut="⌘V"
                  disabled={clipboardCount === 0}
                  onClick={() => {
                    useCanvasStore.getState().pasteClipboard();
                    closeCtx();
                  }}
                />
              </>
            ) : ctxMenu.kind === "node" ? (
              (() => {
                const node = nodes.find((n) => n.id === ctxMenu.id);
                const type = node?.data.nodeType;
                return (
                  <>
                    {type === "storyboard" || type === "video" ? (
                      <CtxItem
                        label="导演台"
                        icon={<Camera className="h-4 w-4" />}
                        onClick={() => {
                          if (node) setDirectorNode(node);
                          closeCtx();
                        }}
                      />
                    ) : null}
                    {type === "note" || type === "script" ? (
                      <CtxItem
                        label="AI 润色正文"
                        icon={<WandSparkles className="h-4 w-4" />}
                        disabled={!(node?.data.body ?? "").trim()}
                        onClick={() => {
                          // 选中节点弹出输入条并预填润色指令（直连管线，
                          // 卡片级模型生效；用户可改指令再撰写）
                          useCanvasStore.getState().selectNodes([ctxMenu.id]);
                          prefillTextWrite(
                            ctxMenu.id,
                            "润色当前正文：保持原意与事实不变，优化文笔、节奏与画面感，直接输出润色后的全文。",
                          );
                          closeCtx();
                        }}
                      />
                    ) : null}
                    {type === "note" || type === "script" ? (
                      <CtxItem
                        label="复制正文"
                        disabled={!(node?.data.body ?? "").trim()}
                        onClick={() => {
                          void navigator.clipboard?.writeText(
                            node?.data.body ?? "",
                          );
                          closeCtx();
                        }}
                      />
                    ) : null}
                    {type === "image" ||
                    (type && ASSET_TYPES.includes(type as never)) ? (
                      node?.data.imageUrl ? (
                        <>
                          <p className="px-2 pb-0.5 pt-1 text-[10px] text-text-4">
                            图片操作
                          </p>
                          <CtxItem
                            label="下载图片"
                            onClick={() => {
                              trackEvent("image.download", { via: "menu" });
                              void downloadMedia(
                                node.data.imageUrl!,
                                node.data.title || "image",
                              ).catch(() => showToast("下载失败，请重试"));
                              closeCtx();
                            }}
                          />
                          <CtxItem
                            label="复制图片"
                            onClick={() => {
                              trackEvent("image.copy-image", { via: "menu" });
                              void copyImageToClipboard(
                                node.data.imageUrl!,
                              ).catch(() =>
                                showToast("复制图片失败，请重试"),
                              );
                              closeCtx();
                            }}
                          />
                          {String(node.data.genPrompt ?? "").trim() ? (
                            <CtxItem
                              label="复制出图提示词"
                              onClick={() => {
                                void navigator.clipboard?.writeText(
                                  String(node.data.genPrompt ?? ""),
                                );
                                closeCtx();
                              }}
                            />
                          ) : null}
                          <CtxItem
                            label="裁剪…"
                            disabled={node?.data.status === "loading"}
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent(IMAGE_TOOL_EVENT, {
                                  detail: {
                                    nodeId: ctxMenu.id,
                                    tool: "crop",
                                  },
                                }),
                              );
                              closeCtx();
                            }}
                          />
                          <CtxItem
                            label={node?.data.freeResize ? "锁定比例" : "自由缩放"}
                            icon={
                              node?.data.freeResize ? (
                                <Lock className="h-4 w-4" />
                              ) : (
                                <LockOpen className="h-4 w-4" />
                              )
                            }
                            onClick={() => {
                              toggleFreeResize(ctxMenu.id);
                              closeCtx();
                            }}
                          />
                          <CtxItem
                            label="多视角…"
                            disabled={node?.data.status === "loading"}
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent(IMAGE_TOOL_EVENT, {
                                  detail: {
                                    nodeId: ctxMenu.id,
                                    tool: "multiview",
                                  },
                                }),
                              );
                              closeCtx();
                            }}
                          />
                          {type === "character" ? (
                            <CtxItem
                              label="三视图…"
                              disabled={node?.data.status === "loading"}
                              onClick={() => {
                                window.dispatchEvent(
                                  new CustomEvent(IMAGE_TOOL_EVENT, {
                                    detail: {
                                      nodeId: ctxMenu.id,
                                      tool: "turnaround",
                                    },
                                  }),
                                );
                                closeCtx();
                              }}
                            />
                          ) : null}
                          <CtxItem
                            label="打光…"
                            disabled={node?.data.status === "loading"}
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent(IMAGE_TOOL_EVENT, {
                                  detail: {
                                    nodeId: ctxMenu.id,
                                    tool: "lighting",
                                  },
                                }),
                              );
                              closeCtx();
                            }}
                          />
                          <CtxItem
                            label="人物质感…"
                            disabled={node?.data.status === "loading"}
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent(IMAGE_TOOL_EVENT, {
                                  detail: {
                                    nodeId: ctxMenu.id,
                                    tool: "texture",
                                  },
                                }),
                              );
                              closeCtx();
                            }}
                          />
                        </>
                      ) : null
                    ) : null}
                    <CtxItem
                      label="复制"
                      onClick={() => {
                        copyNodes([ctxMenu.id]);
                        closeCtx();
                      }}
                    />
                    <CtxItem
                      label={node?.data.locked ? "解锁" : "锁定"}
                      icon={
                        node?.data.locked ? (
                          <LockOpen className="h-4 w-4" />
                        ) : (
                          <Lock className="h-4 w-4" />
                        )
                      }
                      onClick={() => {
                        if (node)
                          useCanvasStore
                            .getState()
                            .updateNodeData(ctxMenu.id, {
                              locked: !node.data.locked,
                            });
                        closeCtx();
                      }}
                    />
                    <CtxItem
                      label="节点信息"
                      icon={<Info className="h-4 w-4" />}
                      onClick={() => {
                        if (node) setInfoNode(node);
                        closeCtx();
                      }}
                    />
                    <CtxItem
                      label="置顶"
                      onClick={() => {
                        useCanvasStore.getState().bringToFront([ctxMenu.id]);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="置底"
                  onClick={() => {
                    useCanvasStore.getState().sendToBack([ctxMenu.id]);
                    closeCtx();
                  }}
                />
                {nodes.find((n) => n.id === ctxMenu.id)?.data.nodeType !==
                "group" ? (
                  <CtxItem
                    label="转换为…"
                    onClick={() =>
                      setCtxMenu({
                        kind: "convert",
                        x: ctxMenu.x,
                        y: ctxMenu.y,
                        id: ctxMenu.id,
                      })
                    }
                  />
                ) : null}
                {nodes.find((n) => n.id === ctxMenu.id)?.data.nodeType ===
                "group" ? (
                  <CtxItem
                    label="解散分组"
                    onClick={() => {
                      useCanvasStore.getState().ungroupNode(ctxMenu.id);
                      closeCtx();
                    }}
                  />
                ) : null}
                <CtxItem
                  label="删除"
                  danger
                  onClick={() => {
                    useCanvasStore.getState().deleteNodes([ctxMenu.id]);
                    closeCtx();
                  }}
                />
                  </>
                );
              })()
            ) : ctxMenu.kind === "convert" ? (
              <>
                <p className="px-2 py-1 text-[10px] text-text-4">转换为（保留内容与连线）</p>
                {CONVERT_TYPES.filter(
                  (t) =>
                    t !==
                    nodes.find((n) => n.id === ctxMenu.id)?.data.nodeType,
                ).map((t) => (
                  <CtxItem
                    key={t}
                    label={NODE_META[t].label}
                    dot={NODE_META[t].dot}
                    onClick={() => {
                      useCanvasStore.getState().convertNodeType(ctxMenu.id, t);
                      closeCtx();
                    }}
                  />
                ))}
              </>
            ) : ctxMenu.kind === "selection" ? (
              <>
                {(() => {
                  const IMG_TYPES = ["image", ...ASSET_TYPES];
                  const imgNodes = nodes
                    .filter(
                      (n) =>
                        ctxMenu.ids.includes(n.id) &&
                        n.data.imageUrl &&
                        IMG_TYPES.includes(n.data.nodeType),
                    )
                    .sort(
                      (a, b) =>
                        a.position.y - b.position.y ||
                        a.position.x - b.position.x,
                    );
                  return imgNodes.length >= 2 ? (
                    <CtxItem
                      label={`合成宫格导出（${imgNodes.length} 图）`}
                      onClick={() => {
                        trackEvent("image.grid-export", {
                          count: imgNodes.length,
                        });
                        void (async () => {
                          try {
                            const blob = await mergeImagesToGrid(
                              imgNodes.map((n, i) => ({
                                url: n.data.imageUrl as string,
                                label: `S${i + 1}`,
                                note: (n.data.title as string) || undefined,
                              })),
                            );
                            downloadBlobFile("wingsight-宫格导出.png", blob);
                          } catch (e) {
                            showToast(
                              `宫格导出失败${e instanceof Error && e.message ? `：${e.message}` : ""}`,
                            );
                          }
                        })();
                        closeCtx();
                      }}
                    />
                  ) : null;
                })()}
                <CtxItem
                  label={`复制 ${ctxMenu.ids.length} 张`}
                  onClick={() => {
                    copyNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="打成一组"
                  onClick={() => {
                    useCanvasStore.getState().groupNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="置顶"
                  onClick={() => {
                    useCanvasStore.getState().bringToFront(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="置底"
                  onClick={() => {
                    useCanvasStore.getState().sendToBack(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="删除"
                  danger
                  onClick={() => {
                    useCanvasStore.getState().deleteNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
              </>
            ) : (
              <CtxItem
                label="删除连线"
                danger
                onClick={() => {
                  deleteEdge(ctxMenu.id);
                  closeCtx();
                }}
              />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
