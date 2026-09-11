"use client";

/**
 * 分镜表批量导入向导（doc/image-node-ops-spec.md §11，open-storyboard
 * PromptImportDialog 简化版）：xlsx/csv/txt → agent /import/tabular 解析 →
 * 列映射（名称列/提示词列，单列表自动整行当提示词）→ 预览 → 批量建图片卡
 * （视口中心网格排布）。解析与建卡分离：解析在 agent（openpyxl），建卡在
 * 前端（本地 store，无 API 逐卡往返）。
 */
import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { NODE_FOOTPRINT, useCanvasStore } from "@/lib/canvas/store";
import { apiFetch } from "@/lib/auth";

type Parsed = {
  headers: string[];
  rows: string[][];
  singleColumn: boolean;
  maxRows: number;
};

export default function ImportStoryboardDialog({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [nameCol, setNameCol] = useState(0);
  const [promptCol, setPromptCol] = useState(1);

  const pick = () => fileRef.current?.click();

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    setBusy(true);
    setFileName(f.name);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await apiFetch("/agent-service/import/tabular", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error((await res.text()) || `解析失败（${res.status}）`);
      const data: Parsed = await res.json();
      if (data.rows.length === 0) throw new Error("没有可导入的数据行");
      // 单列表：整行即提示词；多列：默认 0=名称 1=提示词（越界钳到 0）
      setParsed(data);
      setNameCol(0);
      setPromptCol(data.headers.length > 1 ? 1 : 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "解析失败");
      setParsed(null);
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    if (!parsed) return;
    const st = useCanvasStore.getState();
    // 落点=视口中心（screenToFlow 简化：用当前 viewport 反算）
    const vp = st.viewport;
    const el = document.querySelector(".react-flow")?.getBoundingClientRect();
    const cx = (el ? el.width / 2 : window.innerWidth / 2) - vp.x;
    const cy = (el ? el.height / 2 : window.innerHeight / 2) - vp.y;
    const zoom = vp.zoom || 1;
    const originX = cx / zoom - (NODE_FOOTPRINT.image.w * 3 + 16 * 2) / 2;
    const originY = cy / zoom - ((tileH() + 16) * 2) / 2;
    const tileW = NODE_FOOTPRINT.image.w + 16;
    const created: string[] = [];
    // 整批一次撤销快照：addNode({history:"skip"}) 跳过逐卡入栈
    st.commitHistory();
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      const prompt = (parsed.singleColumn ? r[0] : r[promptCol] ?? "").trim();
      if (!prompt) continue;
      const name =
        parsed.singleColumn
          ? `分镜 ${created.length + 1}`
          : (r[nameCol] ?? "").trim() || `分镜 ${created.length + 1}`;
      const col = created.length % 3;
      const row = Math.floor(created.length / 3);
      const tid = st.addNode(
        {
          position: { x: originX + col * tileW, y: originY + row * (tileH() + 16) },
          data: {
            nodeType: "image",
            title: name,
            body: prompt,
          },
        },
        { history: "skip" },
      );
      created.push(tid);
    }
    if (created.length > 0) {
      useCanvasStore.getState().flashNodes(created);
      onClose();
    } else {
      setErr("没有可导入的行（提示词列全为空）");
    }
  };

  // 预览行文本截断宽度辅助
  const tileH = () => NODE_FOOTPRINT.image.h;

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-[min(46rem,92vw)] flex-col gap-3 overflow-y-auto rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <FileSpreadsheet className="h-4 w-4" />
              导入分镜表
            </h3>
            <p className="mt-0.5 text-[11px] text-text-4">
              xlsx / xls / ods / csv / txt → 批量建图片卡（标题列 + 提示词列），每卡在下方输入条出图
            </p>
          </div>
          <button
            type="button"
            data-tip="关闭" aria-label="关闭"
            className="rounded p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.ods,.csv,.txt"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />

        {!parsed ? (
          <button
            type="button"
            data-track="import.tabular.pick"
            disabled={busy}
            className="flex h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-hairline text-text-3 transition-colors hover:border-accent-soft hover:text-text"
            onClick={pick}
          >
            {busy ? (
              <Loader2 className="h-5 w-5 motion-safe:animate-spin" />
            ) : (
              <FileSpreadsheet className="h-5 w-5" />
            )}
            <span className="text-xs">{busy ? "解析中…" : "点击选择文件（≤10MB，≤200 行）"}</span>
          </button>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="max-w-[12rem] truncate rounded bg-surface-2 px-1.5 py-0.5 text-text-2">
                {fileName}
              </span>
              <span className="text-text-4">{parsed.rows.length} 行</span>
              {!parsed.singleColumn && parsed.headers.length > 1 ? (
                <>
                  <label className="flex items-center gap-1 text-text-3">
                    标题列
                    <select
                      value={nameCol}
                      onChange={(e) => setNameCol(Number(e.target.value))}
                      className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-text"
                    >
                      {parsed.headers.map((h, i) => (
                        <option key={i} value={i}>{h || `列${i + 1}`}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-text-3">
                    提示词列
                    <select
                      value={promptCol}
                      onChange={(e) => setPromptCol(Number(e.target.value))}
                      className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-text"
                    >
                      {parsed.headers.map((h, i) => (
                        <option key={i} value={i}>{h || `列${i + 1}`}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <span className="text-text-4">单列模式：整行作提示词，标题自动编号</span>
              )}
            </div>

            <div className="max-h-56 overflow-y-auto rounded-lg border border-hairline">
              <table className="w-full text-left text-[11px]">
                <tbody>
                  {parsed.rows.slice(0, 8).map((r, i) => (
                    <tr key={i} className="border-b border-hairline/60 last:border-0">
                      <td className="w-8 px-2 py-1 text-text-4">{i + 1}</td>
                      <td className="px-2 py-1 font-medium text-text-2">
                        {(parsed.singleColumn ? `分镜 ${i + 1}` : r[nameCol] || `分镜 ${i + 1}`).slice(0, 20)}
                      </td>
                      <td className="px-2 py-1 text-text-3">
                        {(parsed.singleColumn ? r[0] : r[promptCol] || "").slice(0, 60) || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {err ? <p className="text-xs text-danger">{err}</p> : null}

            <div className="flex shrink-0 items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-3 hover:bg-surface-2 hover:text-text"
                onClick={() => {
                  setParsed(null);
                  setErr("");
                }}
              >
                重选文件
              </button>
              <button
                type="button"
                data-track="import.tabular.create"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                onClick={create}
              >
                建 {parsed.rows.length} 张图片卡
              </button>
            </div>
          </>
        )}

        {!parsed && err ? <p className="text-xs text-danger">{err}</p> : null}
      </div>
    </OverlayModal>
  );
}
