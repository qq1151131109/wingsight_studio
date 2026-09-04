"use client";

/**
 * 画布 ZIP 交付导出（novanova canvas-export 范式）：结构 JSON + 全部媒体
 * blob（原图/视频/音频/候选/版本）打包下载，可离线归档或整包交付。
 * zip 为零依赖 STORE 型打包器（媒体本就是压缩格式，无 deflate 必要；
 * jszip 在仓库里只是传递依赖不可直用）。JSON 内 URL 保持原值（服务端
 * 仍可解析），媒体另存 assets/ 目录做离线副本。
 */

import type { WingNode } from "./store";
import type { WingEdge } from "./store";

// ---------- 最小 STORE 型 zip ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间（本地时区 → DOS 位域；秒粒度 2s） */
function dosTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 打包（STORE，无压缩）：entries 的 name 用 / 分隔目录，data 为原始字节 */
export function makeZip(entries: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, e.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + e.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, eocd] as BlobPart[], {
    type: "application/zip",
  });
}

// ---------- 画布收集与打包 ----------

/** 收画布全部媒体 URL（去重）：主图/视频/音频 + 候选 + 版本档案 */
export function collectMediaUrls(nodes: WingNode[]): string[] {
  const urls = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u === "string" && u.includes("/agent-service/")) urls.add(u);
  };
  for (const n of nodes) {
    add(n.data.imageUrl);
    add(n.data.videoUrl);
    add(n.data.audioUrl);
    for (const u of n.data.imageUrls ?? []) add(u);
    for (const v of n.data.versions ?? []) add(v.url);
    for (const r of n.data.rows ?? [])
      add((r as { imageUrl?: string }).imageUrl ?? undefined);
  }
  return [...urls];
}

export async function exportCanvasZip(opts: {
  projectId: string;
  projectName: string;
  nodes: WingNode[];
  edges: WingEdge[];
  viewport: unknown;
  visualStyle: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ fileCount: number; mediaCount: number }> {
  const { projectId, projectName, nodes, edges, viewport, visualStyle, onProgress } = opts;
  const payload = {
    app: "wingsight-canvas",
    version: 1,
    exportedAt: new Date().toISOString(),
    projectId,
    projectName,
    visualStyle,
    viewport,
    nodes: nodes.map((n) => {
      const rest = { ...(n as Record<string, unknown>) };
      delete rest.selected;
      delete rest.dragging;
      return rest;
    }),
    edges,
  };
  const enc = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [
    { name: "canvas.json", data: enc.encode(JSON.stringify(payload, null, 2)) },
  ];

  const urls = collectMediaUrls(nodes);
  let done = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        const name = `assets/${url.split("/").pop() ?? `f${done}`}`;
        entries.push({ name, data: buf });
      }
    } catch {
      // 单个媒体拉取失败不拦整包（缺哪个 zip 里就没有哪个）
    }
    done += 1;
    onProgress?.(done, urls.length);
  }

  const blob = makeZip(entries);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `画布-${projectName || projectId || "未命名"}-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
  return { fileCount: entries.length, mediaCount: urls.length };
}
