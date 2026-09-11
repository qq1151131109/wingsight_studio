"use client";

/**
 * 同题材可复用考据库：别的项目已经考据过的现成主体（时代共有事实 / 具名个体），
 * 一键引用到本项目——引用是活引用（不拷副本，源项目把结论改对了这里跟着变）。
 *
 * 入口：考证报告卡工具条的「同题材可复用 N」。此前复用只能靠「撞名」——两个
 * 项目把同一件事切成不同名字就永远命中不了，也没有任何地方能看见库里有什么，
 * 于是「不用每次都调研」在真实使用里几乎不生效。
 *
 * 引用目标按**名称归一**匹配画布资产卡（与后端 _norm_name 同口径）；匹配不到
 * 就明说，不静默丢弃——时代主题类主体请走考证大纲的「执行主题」（那条路自带
 * 跨项目复用），本面板只处理「挂到某张卡」。
 */
import { useEffect, useMemo, useState } from "react";
import { BookMarked, Loader2, X } from "lucide-react";

import OverlayModal from "./OverlayModal";
import { getRefLibrary, importRefSubject, type RefLibraryItem } from "@/lib/ref-research";
import { reconcileRefResearch } from "@/lib/canvas/refReconcile";
import { useCanvasStore } from "@/lib/canvas/store";
import { showToast } from "@/lib/toast";

/** 与后端 imgresearch._norm_name 同口径：去空白与常见标点、小写。 */
function normName(v: string): string {
  return String(v || "")
    .toLowerCase()
    .replace(/[\s·、,，.。()（）[\]【】\-—_/]+/g, "");
}

const TYPE_LABELS: Record<string, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  costume: "服饰",
  topic: "时代主题",
};

export default function RefLibraryDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [era, setEra] = useState("");
  const [items, setItems] = useState<RefLibraryItem[]>([]);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");
  // 写卡后卡面要跟着变（简报进 data.researchBrief）——对账一次即可自愈
  const nodes = useCanvasStore((s) => s.nodes);

  useEffect(() => {
    let alive = true;
    getRefLibrary(projectId)
      .then((lib) => {
        if (!alive) return;
        setEra(lib.era);
        setItems(lib.items);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : "考据库加载失败");
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const byName = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      const t = String(n.data.title || "").trim();
      if (t) m.set(normName(t), n.id);
    }
    return m;
  }, [nodes]);

  const doImport = async (item: RefLibraryItem) => {
    const target = byName.get(normName(item.assetName || ""));
    if (!target) {
      showToast(`画布上没有名为「${item.assetName}」的资产卡——先建卡（或改卡名）再引用`);
      return;
    }
    setBusyId(item.id);
    try {
      await importRefSubject(projectId, item.id, "node", target);
      await reconcileRefResearch(projectId).catch(() => {});
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, used: true } : it)),
      );
      showToast(`已引用「${item.assetName}」的考据（活引用，源更新跟着变）`);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : "引用失败");
    } finally {
      setBusyId("");
    }
  };

  const usable = items.filter((i) => !i.used).length;

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6 ws-scrim-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <BookMarked className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-medium text-text">同题材可复用考据</h2>
          {era ? (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-3">
              {era}
            </span>
          ) : null}
          <span className="text-[11px] text-text-4">
            别的项目考据过的现成成果 · 未引用 {usable} 条
          </span>
          <button
            type="button"
            aria-label="关闭"
            className="ml-auto rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {err ? (
            <p className="text-xs text-error">{err}</p>
          ) : !era ? (
            <p className="text-xs text-text-3">
              本项目还没设「时代口径」——库的作用域就是它。在项目设置里填上年代
              （如「北魏·平城时期」「唐·武周」），同题材项目的历史考据才可复用；
              架空/穿越题材不用设。
            </p>
          ) : items.length === 0 ? (
            <p className="text-xs text-text-3">
              「{era}」下还没有可复用的考据。做完一次调研（资产参考图 / 考证大纲）
              之后，同题材的其它项目就能在这里看到并引用。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((it) => {
                const hasCard = byName.has(normName(it.assetName || ""));
                return (
                  <li
                    key={it.id}
                    className="flex gap-3 rounded border border-hairline px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-text">
                        <span className="font-medium">
                          {it.assetName || it.topicKey}
                        </span>
                        <span className="rounded bg-surface-2 px-1 py-0.5 text-[10px] text-text-3">
                          {TYPE_LABELS[it.assetType] ?? it.assetType}
                        </span>
                        <span className="text-[10px] text-text-4">
                          来自《{it.fromProject || "已删项目"}》
                        </span>
                        {it.refCount > 0 ? (
                          <span className="text-[10px] text-text-4">
                            参考图 {it.refCount} 张
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-3">
                        {it.body}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      {it.used ? (
                        <span className="text-[11px] text-text-4">已引用</span>
                      ) : it.kind === "topic" ? (
                        <span
                          className="max-w-[132px] text-right text-[10px] text-text-4"
                          title="时代共有事实请走考证大纲：大纲卡「执行主题」会自动复用同题材结论"
                        >
                          走考证大纲自动复用
                        </span>
                      ) : !hasCard ? (
                        <span
                          className="max-w-[132px] text-right text-[10px] text-text-4"
                          title={`画布上没有名为「${it.assetName}」的资产卡`}
                        >
                          画布无同名卡
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-track="ref.library-import"
                          className="rounded border border-hairline px-2 py-1 text-[11px] text-text-2 hover:bg-surface-2 hover:text-accent disabled:opacity-40"
                          disabled={busyId === it.id}
                          onClick={() => void doImport(it)}
                        >
                          {busyId === it.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "引用"
                          )}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-hairline px-4 py-2 text-[11px] text-text-4">
          引用是活引用：库里的版本更新后本项目跟着变（不存副本）。引用过的资产出图时
          自动带上这份事实与它的参考图集。
        </footer>
      </div>
    </OverlayModal>
  );
}
