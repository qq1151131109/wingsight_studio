"use client";

/**
 * 自由生图工作台面板（juben ImageStudioPage 移植，2026-09-07）。
 *
 * 与画布资产/分镜出图完全隔离（juben 同款约定）：
 * - 不读项目画风、不注入版式契约——agent 侧 assetType="none" + final_prompt
 *   原话直传（版式显选 v3 的 KEEP 语义），想生成什么直接说；
 * - 一次点击多模型并行 = 一个批次（画廊按批次分组），每模型一张卡片；
 * - @图N 注解：提示词里「@图1 锁定脸部」→ 提交时注解并入参考编号行；
 * - 历史画廊数据源 GET /free-images（3s 轮询），产物不写画布、不进资产库
 *   （要上画布：让右侧助手调 generate_free_image 出图后 canvas_ops 建卡）。
 *
 * 挂在项目域工作台壳里（/project/[pid]/image-studio）：projectId 来自
 * canvas store（ProjectManager 按路由激活）；per-project 状态在
 * `<StudioPane key={projectId}>` 里——切项目靠重挂载复位 + 草稿惰性初始化
 * （PromptBar 按 nodeId key 同款），不在 effect 里 setState（React Compiler）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Download,
  ImagePlus,
  Loader2,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";

import PromptMentionTextarea from "@/components/image-studio/PromptMentionTextarea";
import { assetThumbUrl } from "@/lib/asset-thumb";
import { useCanvasStore } from "@/lib/canvas/store";
import { uploadAsset } from "@/lib/projects";
import { useImageModels, findModelOption, type ImageModelOption } from "@/lib/imagegen";
import {
  generateFreeImages,
  listFreeImages,
  type FreeImageItem,
} from "@/lib/freeImages";

const PROMPT_MAX = 6000;
const DEFAULT_ASPECT = "16:9";
const POLL_MS = 3000;
const DRAFT_KEY = "wingsight:freeImageDraftByProject";

interface RefState {
  url: string;
  filename: string;
}

interface DraftState {
  prompt: string;
  aspect: string;
  resolution: string;
  selectedModels: string[];
  references: { url: string; filename: string }[];
}

function readDraft(pid: string): DraftState {
  const base: DraftState = {
    prompt: "",
    aspect: DEFAULT_ASPECT,
    resolution: "",
    selectedModels: [],
    references: [],
  };
  try {
    const map = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || "{}") as Record<
      string,
      Partial<DraftState>
    >;
    const d = map[pid];
    if (!d || typeof d !== "object") return base;
    return {
      prompt: typeof d.prompt === "string" ? d.prompt : "",
      aspect: typeof d.aspect === "string" && d.aspect ? d.aspect : DEFAULT_ASPECT,
      resolution: typeof d.resolution === "string" ? d.resolution : "",
      selectedModels: Array.isArray(d.selectedModels)
        ? d.selectedModels.filter((m): m is string => typeof m === "string")
        : [],
      references: Array.isArray(d.references)
        ? d.references.filter(
            (r): r is { url: string; filename: string } =>
              !!r && typeof r.url === "string" && typeof r.filename === "string",
          )
        : [],
    };
  } catch {
    return base;
  }
}

export default function FreeImageStudio() {
  const projectId = useCanvasStore((s) => s.projectId);
  const { models, error: modelsError } = useImageModels();

  if (!projectId) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-3" />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2.5 border-b border-hairline-soft bg-surface-1 px-4">
        <h1 className="m-0 text-sm font-semibold text-text">自由生图</h1>
        <span className="text-[11px] text-text-4">
          不受画风与资产约束 · 原话直传不套版式 · 结果不进画布（想上画布让右侧助手送）
        </span>
      </div>
      <StudioPane key={projectId} projectId={projectId} models={models} modelsError={modelsError} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 工作台主体（per-project：切项目重挂载，草稿惰性初始化）
// ---------------------------------------------------------------------------

function StudioPane({
  projectId,
  models,
  modelsError,
}: {
  projectId: string;
  models: ImageModelOption[] | null;
  modelsError: string;
}) {
  const [draft] = useState(() => readDraft(projectId));
  const [prompt, setPrompt] = useState(draft.prompt);
  const [aspectRaw, setAspect] = useState(draft.aspect);
  const [resolutionRaw, setResolution] = useState(draft.resolution);
  const [selectedModels, setSelectedModels] = useState<string[]>(draft.selectedModels);
  const [references, setReferences] = useState<RefState[]>(draft.references);

  const [items, setItems] = useState<FreeImageItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<FreeImageItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 派生（模型目录异步到达 / 交集校验都在渲染期算，不在 effect 里改状态） ──
  const effectiveModels = useMemo(() => {
    if (!models) return selectedModels;
    const retained = selectedModels.filter((id) => models.some((m) => m.id === id));
    if (retained.length > 0) return retained;
    const rec = models.find((m) => m.recommended) ?? models[0];
    return rec ? [rec.id] : [];
  }, [models, selectedModels]);
  const selected = useMemo(
    () => effectiveModels.map((id) => findModelOption(id, models)).filter(Boolean),
    [effectiveModels, models],
  );
  const intersect = (lists: string[][]) => lists.reduce((a, l) => a.filter((x) => l.includes(x)));
  const aspectOptions = useMemo(() => {
    if (selected.length === 0)
      return models?.[0]?.aspects ?? ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
    return intersect(selected.map((m) => m!.aspects ?? []));
  }, [selected, models]);
  const resolutionOptions = useMemo(() => {
    if (selected.length === 0) return ["", "1K", "2K", "4K"];
    return ["", ...intersect(selected.map((m) => m!.resolutions ?? []))];
  }, [selected]);
  const aspect = aspectOptions.includes(aspectRaw) ? aspectRaw : (aspectOptions[0] ?? aspectRaw);
  const resolution = resolutionOptions.includes(resolutionRaw) ? resolutionRaw : "";
  const maxRefs =
    selected.length > 0
      ? Math.min(...selected.map((m) => m!.max_references ?? 4))
      : (models?.[0]?.max_references ?? 4);

  // ── 草稿防抖写回（纯外部系统同步，无 setState） ─────────────────────────────
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const map = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || "{}");
        map[projectId] = {
          prompt,
          aspect,
          resolution,
          selectedModels: effectiveModels,
          references: references.map(({ url, filename }) => ({ url, filename })),
        } satisfies DraftState;
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(map));
      } catch {
        /* quota / 隐私模式：表单照常可用 */
      }
    }, 400);
    return () => window.clearTimeout(id);
  }, [projectId, prompt, aspect, resolution, effectiveModels, references]);

  // ── 画廊轮询：3s 常开（页面隐藏暂停）；setState 全在异步回调里 ──────────────
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      void listFreeImages(projectId)
        .then((list) => {
          if (alive) setItems(list);
        })
        .catch(() => {
          /* 服务闪断：保留现有画廊，下轮重试 */
        });
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [projectId]);

  // ── 参考图：上传 / 删除 / 排序（按钮 + 原生拖拽，@图N 编号即列表位次） ───────
  const handleUploadRefs = useCallback(
    async (files: FileList | File[]) => {
      const remaining = maxRefs - references.length;
      const candidates = Array.from(files)
        .filter((f) => f.type.startsWith("image/"))
        .slice(0, remaining);
      if (candidates.length === 0) return;
      setUploading(true);
      setError(null);
      try {
        const uploaded: RefState[] = [];
        for (const file of candidates) {
          const url = await uploadAsset(file, file.type, file.name);
          if (url) uploaded.push({ url, filename: file.name });
        }
        if (uploaded.length === 0) setError("参考图上传失败，请重试");
        setReferences((prev) => [...prev, ...uploaded]);
      } finally {
        setUploading(false);
      }
    },
    [references.length, maxRefs],
  );

  const removeRef = (url: string) => setReferences((prev) => prev.filter((r) => r.url !== url));
  // 拖拽重排（dnd-kit）+ 按钮上下移：@图N 编号自动跟随位次
  const moveRef = (url: string, dir: -1 | 1) =>
    setReferences((prev) => {
      const i = prev.findIndex((r) => r.url === url);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      return arrayMove(prev, i, j);
    });
  const reorderRef = (fromUrl: string, toUrl: string) =>
    setReferences((prev) => {
      const from = prev.findIndex((r) => r.url === fromUrl);
      const to = prev.findIndex((r) => r.url === toUrl);
      if (from < 0 || to < 0 || from === to) return prev;
      return arrayMove(prev, from, to);
    });

  // ── @图N 插入（光标处）；reuse（历史图作参考）；回填 ───────────────────────
  const insertRefAtCursor = useCallback((text: string) => {
    const el = document.getElementById("free-image-prompt") as HTMLTextAreaElement | null;
    setPrompt((cur) => {
      if (!el) return `${cur}${cur && !cur.endsWith(" ") ? " " : ""}${text}`;
      const start = el.selectionStart ?? cur.length;
      const end = el.selectionEnd ?? cur.length;
      const next = `${cur.slice(0, start)}${text}${cur.slice(end)}`;
      requestAnimationFrame(() => {
        const pos = start + text.length;
        el.setSelectionRange(pos, pos);
        el.focus();
      });
      return next;
    });
  }, []);

  const reuseAsReference = useCallback(
    (item: FreeImageItem) => {
      const url = item.imageUrl;
      if (!url) return;
      setReferences((prev) =>
        prev.some((r) => r.url === url) || prev.length >= maxRefs
          ? prev
          : [...prev, { url, filename: url.split("/").pop() ?? "图" }],
      );
    },
    [maxRefs],
  );

  const restoreFromItem = useCallback((item: FreeImageItem) => {
    setPrompt(item.prompt ?? "");
    setReferences(
      (item.referenceUrls ?? []).map((url) => ({
        url,
        filename: url.split("/").pop() ?? "参考图",
      })),
    );
    if (item.aspect) setAspect(item.aspect);
    setResolution(item.resolution || "");
    if (item.modelId) setSelectedModels([item.modelId]);
  }, []);

  // ── 生成：多模型并行一批次；提交后立即拉一次画廊（行已落库） ────────────────
  const canGenerate =
    prompt.trim().length > 0 && prompt.length <= PROMPT_MAX && effectiveModels.length > 0 && !busy;

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setBusy(true);
    setError(null);
    try {
      await generateFreeImages({
        projectId,
        prompt: prompt.trim(),
        aspect,
        ...(resolution ? { resolution } : {}),
        models: effectiveModels,
        referenceImages: references.map((r) => r.url),
      });
      setItems(await listFreeImages(projectId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "提交失败，请重试");
    } finally {
      setBusy(false);
    }
  }, [projectId, canGenerate, prompt, aspect, resolution, effectiveModels, references]);

  const handlePromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (canGenerate) void handleGenerate();
    }
  };

  const toggleModel = (id: string) =>
    setSelectedModels(
      effectiveModels.includes(id)
        ? effectiveModels.filter((x) => x !== id)
        : [...effectiveModels, id],
    );

  // ── 画廊分组（批次）+ 关键词过滤 ────────────────────────────────────────────
  const groups = useMemo(() => {
    const kw = searchTerm.trim().toLowerCase();
    const byBatch = new Map<string, FreeImageItem[]>();
    for (const it of items) {
      if (kw && !(it.prompt ?? "").toLowerCase().includes(kw)) continue;
      const list = byBatch.get(it.batchId) ?? [];
      list.push(it);
      byBatch.set(it.batchId, list);
    }
    return [...byBatch.entries()].map(([batchId, list]) => ({ batchId, list }));
  }, [items, searchTerm]);
  const galleryTotal = groups.reduce((n, g) => n + g.list.length, 0);
  const modelLabel = useCallback(
    (id: string) => findModelOption(id, models)?.label ?? id,
    [models],
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── 左栏：表单 ─────────────────────────────────────────────────── */}
      <aside className="flex w-[400px] shrink-0 flex-col overflow-y-auto border-r border-hairline-soft bg-surface-1">
        <div className="space-y-5 px-5 py-5">
          <div>
            <label htmlFor="free-image-prompt" className="mb-1.5 block text-xs font-semibold text-text-2">
              提示词
            </label>
            <PromptMentionTextarea
              id="free-image-prompt"
              value={prompt}
              onChange={setPrompt}
              onKeyDown={handlePromptKeyDown}
              references={references}
              maxLength={PROMPT_MAX}
              placeholder="描述想生成的画面；@图N 可指定参考图（如：@图1 锁定脸部）"
              ariaLabel="提示词"
            />
            <div className="mt-1 flex items-center justify-between">
              {references.length > 0 ? (
                <span className="text-[10px] text-accent-2/80">
                  @图N = 第 N 张参考图 · 提示词里可写注解（@图1 锁定脸部）
                </span>
              ) : (
                <span />
              )}
              <span className="text-[10px] text-text-4">
                {prompt.length}/{PROMPT_MAX}
              </span>
            </div>
          </div>

          {/* 参考图（上传 / 拖拽排序 / @ 插入；上限随所选模型收窄） */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold text-text-2">参考图</span>
              <span className="text-[10px] text-text-4">
                {references.length} / {maxRefs}（{selected.length > 1 ? "所选模型最小上限" : "上限"}）
              </span>
            </div>
            <SortableRefGrid
              references={references}
              onRemove={removeRef}
              onInsert={insertRefAtCursor}
              onMove={moveRef}
              onReorder={reorderRef}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void handleUploadRefs(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploading || references.length >= maxRefs}
              onClick={() => fileInputRef.current?.click()}
              data-track="freeimage.upload-ref"
              className="flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-hairline bg-surface-2 px-3 py-3 text-center text-xs text-text-3 transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading
                ? "上传中…"
                : references.length >= maxRefs
                  ? `参考图已满（${maxRefs} 张）`
                  : "上传参考图"}
            </button>
          </div>

          {/* 画幅（所选模型交集；空交集明说不静默） */}
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-text-2">
              画幅{selected.length > 1 ? "（所选模型交集）" : ""}
            </span>
            {aspectOptions.length === 0 ? (
              <p className="rounded-md border border-hairline-soft bg-surface-2 px-3 py-2 text-[11px] text-warn">
                所选模型的画幅没有交集，请减少模型或改用单模型
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {aspectOptions.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAspect(a)}
                    className={`h-8 rounded-md border text-xs font-medium transition-colors ${
                      aspect === a
                        ? "border-accent bg-accent-dim text-accent-2"
                        : "border-hairline bg-surface-2 text-text-3 hover:border-hairline-strong"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 档位（空 = 跟随模型默认） */}
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-text-2">清晰度档位</span>
            <div className="grid grid-cols-4 gap-1.5">
              {resolutionOptions.map((s) => (
                <button
                  key={s || "auto"}
                  type="button"
                  onClick={() => setResolution(s)}
                  className={`h-8 rounded-md border text-xs font-medium transition-colors ${
                    resolution === s
                      ? "border-accent bg-accent-dim text-accent-2"
                      : "border-hairline bg-surface-2 text-text-3 hover:border-hairline-strong"
                  }`}
                >
                  {s || "默认"}
                </button>
              ))}
            </div>
          </div>

          {/* 模型多选（目录来自 agent /models/image，多选 = 并行各出一张） */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold text-text-2">出图模型（可多选并行）</span>
              {models && models.length > 1 && effectiveModels.length === models.length ? (
                <button
                  type="button"
                  onClick={() => setSelectedModels([models[0].id])}
                  className="text-[10px] text-accent-2 hover:text-accent"
                >
                  只留一个
                </button>
              ) : null}
            </div>
            {!models ? (
              <p className="flex items-center gap-1.5 rounded-md border border-hairline-soft bg-surface-2 px-3 py-2 text-[11px] text-text-3">
                <Loader2 className="h-3 w-3 animate-spin" /> 加载模型目录…
              </p>
            ) : (
              <ul className="m-0 max-h-44 list-none overflow-y-auto rounded-md border border-hairline-soft bg-surface-2 p-0">
                {models.map((m) => (
                  <li
                    key={m.id}
                    className="flex min-h-9 items-center gap-2 border-b border-hairline-soft px-2.5 last:border-b-0"
                  >
                    <input
                      id={`fm-${m.id}`}
                      type="checkbox"
                      checked={effectiveModels.includes(m.id)}
                      onChange={() => toggleModel(m.id)}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                    />
                    <label htmlFor={`fm-${m.id}`} className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5">
                      <span className="text-[11px] text-text-2">{m.label}</span>
                      <span className="truncate text-[10px] text-text-4" title={m.tag}>
                        {m.tag}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {modelsError ? <p className="mt-1 text-[10px] text-warn">{modelsError}</p> : null}
            {effectiveModels.length > 1 ? (
              <p className="mt-1 text-[10px] text-accent-2/80">
                已选 {effectiveModels.length} 个模型：一次点击并行各出一张
              </p>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-hairline-soft bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-300"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!canGenerate}
            data-track="freeimage.generate"
            data-track-props={JSON.stringify({
              models: effectiveModels.length,
              refs: references.length,
            })}
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-accent text-sm font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? "提交中…" : `生成${effectiveModels.length > 1 ? ` ×${effectiveModels.length}` : ""}`}
          </button>
          <p className="text-center text-[10px] text-text-4">⌘/Ctrl + Enter 生成 · 原话直传出图，不套版式</p>
        </div>
      </aside>

      {/* ── 右栏：画廊（与聊天侧栏之间，侧栏让位逻辑同工作台） ──────────────── */}
      <section className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="m-0 text-sm font-semibold text-text">
            生成画廊
            {galleryTotal > 0 ? (
              <span className="ml-2 text-xs font-normal text-text-3">{galleryTotal} 张</span>
            ) : null}
          </h2>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-4" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索提示词"
              aria-label="搜索提示词"
              className="h-8 w-52 rounded-md border border-hairline bg-surface-2 pl-7 pr-2 text-xs text-text-2 placeholder:text-text-4 focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="grid place-items-center rounded-lg border border-dashed border-hairline-soft bg-surface-1 px-6 py-16 text-center">
            <ImagePlus className="mb-3 h-8 w-8 text-text-4" />
            <p className="m-0 text-sm font-medium text-text-2">还没有生成记录</p>
            <p className="mb-0 mt-1 max-w-xs text-xs text-text-3">
              左侧填好提示词（可带参考图）点生成；多选模型可一次并行对比，也可以直接让右侧助手帮你出
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.batchId}>
                <div className="mb-2 flex items-center gap-2">
                  <h3
                    className="m-0 min-w-0 flex-1 truncate text-xs font-semibold text-text-2"
                    title={g.list[0]?.prompt}
                  >
                    {g.list[0]?.prompt || "（无提示词）"}
                  </h3>
                  <span className="shrink-0 rounded-full border border-hairline-soft bg-surface-2 px-2 py-0.5 text-[10px] text-text-3">
                    {g.list[0]?.createdAt?.slice(5, 16).replace("T", " ") ?? ""} · {g.list.length} 张
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                  {g.list.map((item) =>
                    item.status === "done" && item.imageUrl ? (
                      <DoneCard
                        key={item.id}
                        item={item}
                        modelText={modelLabel(item.modelId)}
                        onOpen={() => setLightbox(item)}
                        onReuse={() => reuseAsReference(item)}
                        onRestore={() => restoreFromItem(item)}
                      />
                    ) : item.status === "error" ? (
                      <FailedCard
                        key={item.id}
                        item={item}
                        modelText={modelLabel(item.modelId)}
                        onRetry={() => restoreFromItem(item)}
                      />
                    ) : (
                      <PendingCard key={item.id} item={item} modelText={modelLabel(item.modelId)} />
                    ),
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      {lightbox ? (
        <Lightbox item={lightbox} modelText={modelLabel(lightbox.modelId)} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

/** 参考图网格（juben ReferencesField 移植）：dnd-kit 指针拖拽排序 +
 *  悬停工具栏（@ 插入 / 上下移 / 删除，pointerdown stopPropagation 防误触拖拽） */
function SortableRefGrid({
  references,
  onRemove,
  onInsert,
  onMove,
  onReorder,
}: {
  references: RefState[];
  onRemove: (url: string) => void;
  onInsert: (text: string) => void;
  onMove: (url: string, dir: -1 | 1) => void;
  onReorder: (fromUrl: string, toUrl: string) => void;
}) {
  // distance 避免点击工具栏按钮时误触发拖拽（juben 同款 6px 阈值）
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const ids = useMemo(() => references.map((r) => r.url), [references]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      onReorder(String(active.id), String(over.id));
    },
    [onReorder],
  );
  if (references.length === 0) return null;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <ul className="mb-2 grid grid-cols-4 gap-2" aria-label="参考图列表，可拖拽排序">
          {references.map((r, i) => (
            <SortableRefThumb
              key={r.url}
              item={r}
              index={i}
              total={references.length}
              onRemove={() => onRemove(r.url)}
              onInsert={() => onInsert(`@图${i + 1} `)}
              onMove={(d) => onMove(r.url, d)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRefThumb({
  item,
  index,
  total,
  onRemove,
  onInsert,
  onMove,
}: {
  item: RefState;
  index: number;
  total: number;
  onRemove: () => void;
  onInsert: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.url,
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 20 : undefined,
      }}
      className={`group relative aspect-square touch-none overflow-hidden rounded-md border border-hairline-soft bg-surface-2 ${
        isDragging ? "opacity-70 shadow-md ring-2 ring-accent/40" : "cursor-grab active:cursor-grabbing"
      }`}
      {...attributes}
      {...listeners}
      aria-label={`参考图${index + 1}：${item.filename}，可拖拽排序`}
    >
      <span className="pointer-events-none absolute left-0 top-0 z-10 rounded-br bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-white">
        图{index + 1}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={assetThumbUrl(item.url)}
        alt={item.filename}
        className="pointer-events-none h-full w-full object-contain"
        title={item.filename}
        draggable={false}
      />
      {/* 悬停工具栏：@ 插入 + 上移 + 下移 + 删除；按钮 stopPropagation 避免启动拖拽 */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/55 px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          title="插入 @图N 到提示词"
          aria-label={`插入 @图${index + 1} 到提示词`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onInsert();
          }}
          className="grid h-5 w-5 place-items-center rounded text-white hover:bg-white/20"
        >
          @
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="上移"
            aria-label="上移参考图"
            disabled={index === 0}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onMove(-1);
            }}
            className="grid h-5 w-5 place-items-center rounded text-white hover:bg-white/20 disabled:opacity-30"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="下移"
            aria-label="下移参考图"
            disabled={index === total - 1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onMove(1);
            }}
            className="grid h-5 w-5 place-items-center rounded text-white hover:bg-white/20 disabled:opacity-30"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="移除参考图"
            aria-label="移除参考图"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="grid h-5 w-5 place-items-center rounded text-white hover:bg-white/20"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    </li>
  );
}

function PendingCard({ item, modelText }: { item: FreeImageItem; modelText: string }) {
  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-hairline-soft bg-surface-1">
      <Loader2 className="h-5 w-5 animate-spin text-accent" />
      <span className="text-xs text-text-3">{item.status === "running" ? "生成中…" : "排队中"}</span>
      <span className="text-[10px] text-text-4">{modelText}</span>
    </div>
  );
}

function DoneCard({
  item,
  modelText,
  onOpen,
  onReuse,
  onRestore,
}: {
  item: FreeImageItem;
  modelText: string;
  onOpen: () => void;
  onReuse: () => void;
  onRestore: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!item.imageUrl) return null;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${item.imageUrl}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板权限拒绝：无提示静默 */
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-hairline-soft bg-surface-1">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full bg-surface-2"
        style={{ aspectRatio: (item.aspect || "16:9").replace(":", "/") }}
        aria-label="放大查看"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={assetThumbUrl(item.imageUrl)}
          alt={(item.prompt ?? "").slice(0, 50)}
          className="h-full w-full object-contain"
          loading="lazy"
        />
      </button>
      <div className="px-2.5 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-text-4" title={modelText}>
            {[modelText, item.aspect, item.resolution].filter(Boolean).join(" · ") || "—"}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={onReuse}
              title="作为参考图（加入左侧参考列表）"
              aria-label="作为参考图"
              data-track="freeimage.reuse"
              className="grid h-6 w-6 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-accent"
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onRestore}
              title="回填参数（改一版重新生成）"
              aria-label="回填参数"
              data-track="freeimage.restore"
              className="grid h-6 w-6 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-accent"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void copyLink()}
              title={copied ? "已复制" : "复制图片链接"}
              aria-label="复制图片链接"
              className="grid h-6 w-6 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-accent"
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
            </button>
            <a
              href={item.imageUrl}
              download
              title="下载原图"
              aria-label="下载原图"
              className="grid h-6 w-6 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-accent"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={onOpen}
              title="放大查看（含实际提示词）"
              aria-label="放大查看"
              className="grid h-6 w-6 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-accent"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <p className="m-0 line-clamp-2 text-[11px] leading-relaxed text-text-2" title={item.prompt}>
          {item.prompt || "—"}
        </p>
        {item.referenceUrls.length > 0 ? (
          <div className="mt-2 space-y-1.5 border-t border-hairline-soft pt-2">
            <span className="text-[10px] text-text-4">
              本次用了 {item.referenceUrls.length} 张参考
            </span>
            <div className="flex flex-wrap gap-1">
              {item.referenceUrls.map((u, i) => (
                <span key={u} className="relative">
                  <span className="absolute left-0 top-0 z-10 rounded-br bg-black/60 px-1 text-[8px] font-semibold text-white">
                    图{i + 1}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={assetThumbUrl(u)}
                    alt={`参考图${i + 1}`}
                    className="h-10 w-10 rounded border border-hairline-soft object-cover"
                  />
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FailedCard({
  item,
  modelText,
  onRetry,
}: {
  item: FreeImageItem;
  modelText: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex aspect-video flex-col justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950/30">
      <div className="flex items-center gap-1.5">
        <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        <span className="text-[10px] text-red-700 dark:text-red-300">{modelText} 生成失败</span>
      </div>
      <p className="m-0 line-clamp-3 text-[11px] text-red-800 dark:text-red-300">
        {item.error ?? "未知错误"}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 items-center gap-1 self-start rounded border border-red-200 bg-surface-1 px-2 text-[11px] text-red-700 hover:bg-red-100 dark:border-red-900 dark:text-red-300"
      >
        <RotateCcw className="h-3 w-3" />
        回填参数重试
      </button>
    </div>
  );
}

function Lightbox({
  item,
  modelText,
  onClose,
}: {
  item: FreeImageItem;
  modelText: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!item.imageUrl) return null;
  return (
    <div
      className="fixed inset-0 z-[1300] flex flex-col items-center justify-center gap-3 bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-label="图片预览"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.imageUrl}
        alt={(item.prompt ?? "").slice(0, 50)}
        className="max-h-[70vh] max-w-full rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <div
        className="max-h-[20vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-surface-1/95 px-4 py-3 text-[11px] leading-relaxed text-text-2"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="m-0 mb-1 font-semibold text-text">
          {[modelText, item.aspect, item.resolution].filter(Boolean).join(" · ")}
        </p>
        <p className="m-0 mb-2 whitespace-pre-wrap text-text-2">{item.prompt}</p>
        {item.finalPrompt ? (
          <details>
            <summary className="cursor-pointer select-none text-text-3">实际发送的提示词</summary>
            <p className="m-0 mt-1 whitespace-pre-wrap text-text-3">{item.finalPrompt}</p>
          </details>
        ) : null}
        {item.referenceUrls.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {item.referenceUrls.map((u, i) => (
              <span key={u} className="relative">
                <span className="absolute left-0 top-0 z-10 rounded-br bg-black/60 px-1 text-[8px] font-semibold text-white">
                  图{i + 1}
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={assetThumbUrl(u)}
                  alt={`参考图${i + 1}`}
                  className="h-10 w-10 rounded border border-hairline-soft object-cover"
                />
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
