"use client";

/**
 * 宫格合成导出（doc/image-node-ops-spec.md P1-3，九宫格切图的逆操作）：
 * 多张图合成一张 rows×cols 大图（分镜交付格式）。纯前端 canvas 排版，零 API
 * ——Storyboard-Copilot merge_storyboard_images 范式：帧编号徽标 + 帧备注 +
 * 间距/边距 + cover/contain 填充 + 总边长 clamp（导出上限 8192）。
 */

export type GridFrame = {
  url: string;
  /** 帧编号徽标（如 镜3 / S1）；空则不画 */
  label?: string;
  /** 帧下方备注（截断 ~32 字）；空则不画 */
  note?: string;
};

export type GridMergeOpts = {
  /** 列数；缺省按 n 的近方根自动 */
  cols?: number;
  /** 单元格间距/画布外边距（px） */
  gap?: number;
  margin?: number;
  /** 画布底色 */
  bg?: string;
  /** 单元格填充：contain 完整显示 / cover 铺满裁切 */
  fit?: "contain" | "cover";
};

const MAX_EDGE = 8192;
const NOTE_CHARS = 32;

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${url.slice(0, 60)}`));
    img.src = url;
  });
}

/** cover/contain 的 drawImage 参数（cover 居中裁切，contain 完整显示居中） */
function fitRect(
  iw: number,
  ih: number,
  cw: number,
  ch: number,
  fit: "contain" | "cover",
): { dx: number; dy: number; dw: number; dh: number } {
  const sr = iw / ih;
  const cr = cw / ch;
  const contain = fit === "contain" ? sr > cr : sr < cr;
  if (contain) {
    const dw = cw;
    const dh = cw / sr;
    return { dx: 0, dy: (ch - dh) / 2, dw, dh };
  }
  const dh = ch;
  const dw = ch * sr;
  return { dx: (cw - dw) / 2, dy: 0, dw, dh };
}

/** 合成宫格大图。全部帧必须可加载，任一失败整单报错（不静默缺帧）。 */
export async function mergeImagesToGrid(
  frames: GridFrame[],
  opts: GridMergeOpts = {},
): Promise<Blob> {
  if (frames.length === 0) throw new Error("没有可合成的图片");
  const gap = opts.gap ?? 24;
  const margin = opts.margin ?? 32;
  const bg = opts.bg ?? "#ffffff";
  const fit = opts.fit ?? "contain";
  const imgs = await Promise.all(frames.map((f) => loadImg(f.url)));

  // 单元格 = 最大帧等比下探到统一格（上限 1024，防 4K 帧把总图顶爆）
  let cellW = 0;
  let cellH = 0;
  for (const img of imgs) {
    const s = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    cellW = Math.max(cellW, Math.round(img.naturalWidth * s));
    cellH = Math.max(cellH, Math.round(img.naturalHeight * s));
  }
  const noteSpace = frames.some((f) => f.note) ? 56 : 0;
  let cellH2 = cellH + noteSpace;
  const cols = Math.min(
    opts.cols ?? Math.ceil(Math.sqrt(frames.length)),
    frames.length,
  );
  const rows = Math.ceil(frames.length / cols);
  let outW = margin * 2 + cols * cellW + (cols - 1) * gap;
  let outH = margin * 2 + rows * cellH2 + (rows - 1) * gap;
  // 总边长 clamp（等比缩整单）
  const over = Math.max(outW, outH) / MAX_EDGE;
  if (over > 1) {
    outW = Math.floor(outW / over);
    outH = Math.floor(outH / over);
    cellW = Math.floor(cellW / over);
    cellH2 = Math.floor(cellH2 / over);
  }

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布创建失败");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, outW, outH);
  ctx.textBaseline = "top";

  const font = Math.max(18, Math.round(cellW / 26));
  frames.forEach((f, i) => {
    const img = imgs[i];
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = margin + c * (cellW + gap);
    const y = margin + r * (cellH2 + gap);
    const { dx, dy, dw, dh } = fitRect(
      img.naturalWidth,
      img.naturalHeight,
      cellW,
      cellH,
      fit,
    );
    ctx.drawImage(img, x + dx, y + dy, dw, dh);

    if (f.label) {
      ctx.font = `bold ${font}px "Noto Sans SC", "PingFang SC", sans-serif`;
      const tw = ctx.measureText(f.label).width;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(x + 8, y + 8, tw + font, font + 10);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(f.label, x + 8 + font / 2, y + 8 + 5);
    }
    if (f.note) {
      ctx.font = `${Math.max(15, font - 4)}px "Noto Sans SC", "PingFang SC", sans-serif`;
      ctx.fillStyle = "#44403c";
      const note =
        f.note.length > NOTE_CHARS
          ? `${f.note.slice(0, NOTE_CHARS)}…`
          : f.note;
      ctx.fillText(note, x + 4, y + cellH + 10, cellW - 8);
    }
  });

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) throw new Error("合成导出失败");
  return blob;
}

/** 下载 blob（宫格导出是纯前端产物，不经服务端上传） */
export function downloadBlobFile(name: string, blob: Blob): void {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "wingsight.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}
