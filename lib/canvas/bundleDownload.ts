/** 画布媒体批量下载：一键把结果（图片/视频/音频）打包成 zip 落盘。
 *  机制对标 novanova / open-ai-canvas：fflate zipSync level 0（媒体已是压缩
 *  格式，再压只费 CPU 不省体积）+ zip 内带 清单.json（文件↔卡片的对应底账）；
 *  单个媒体跳过打包直接走 downloadMedia 快路径。 */

import { strToU8, zipSync } from "fflate";
import type { WingNode } from "@/lib/canvas/store";
import { downloadMedia, sanitizeName } from "@/lib/download";

export type MediaKind = "image" | "video" | "audio";

export interface MediaEntry {
  url: string;
  title: string;
  nodeId: string;
  nodeType: string;
  kind: MediaKind;
  /** 同卡同类的第几张（1 起）。单图/唯一媒体为 0，命名时不带「候选N」后缀 */
  variant: number;
}

const EXT_BY_URL = /\.(png|jpe?g|webp|gif|bmp|svg|mp4|webm|mov|mp3|wav|m4a|flac|ogg|aac)(\?|$)/i;
const FALLBACK_EXT: Record<MediaKind, string> = {
  image: "png",
  video: "mp4",
  audio: "mp3",
};

export function extOf(entry: MediaEntry): string {
  const m = EXT_BY_URL.exec(entry.url);
  if (!m) return FALLBACK_EXT[entry.kind];
  return m[1].toLowerCase().replace("jpeg", "jpg");
}

/** 从节点收集媒体产物：候选列表优先（全收），否则单图；再加视频/音频。
 *  同 URL 跨卡去重（保留首遇，zip 内只存一份）。ids 传时只收选中卡。 */
export function collectMediaEntries(nodes: WingNode[], ids?: string[]): MediaEntry[] {
  const wanted = ids ? new Set(ids) : null;
  const byUrl = new Map<string, MediaEntry>();
  const push = (n: WingNode, url: string, kind: MediaKind, variant: number) => {
    if (!url || byUrl.has(url)) return;
    byUrl.set(url, {
      url,
      title: n.data.title ?? "",
      nodeId: n.id,
      nodeType: n.data.nodeType,
      kind,
      variant,
    });
  };
  for (const n of nodes) {
    if (wanted && !wanted.has(n.id)) continue;
    const d = n.data;
    if (d.imageUrls?.length) {
      d.imageUrls.forEach((url, i) => push(n, url, "image", i + 1));
    } else {
      push(n, d.imageUrl ?? "", "image", 0);
    }
    push(n, d.videoUrl ?? "", "video", 0);
    push(n, d.audioUrl ?? "", "audio", 0);
  }
  return [...byUrl.values()];
}

/** zip 内文件名：{两位序号}_{卡标题}_{节点id前6}[_候选N].{ext}。
 *  标题非法字符清洗 + 截 60 字；同卡多候选统一带「候选N」；Windows 保留名加前缀 */
export function bundleFileName(entries: MediaEntry[], seq: number): string {
  const e = entries[seq];
  const siblings = entries.filter(
    (x) => x.nodeId === e.nodeId && x.kind === e.kind,
  ).length;
  const base = (sanitizeName(e.title).slice(0, 60) || "未命名").replace(/^\.+/, "");
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? `_${base}` : base;
  const variantSuffix = siblings > 1 && e.variant > 0 ? `_候选${e.variant}` : "";
  return `${String(seq + 1).padStart(2, "0")}_${safe}_${e.nodeId.slice(0, 6)}${variantSuffix}.${extOf(e)}`;
}

function saveBlob(blob: Blob, filename: string): void {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export interface BundleResult {
  /** 成功落盘（zip 内或单文件）的媒体数 */
  ok: number;
  /** 拉取失败被跳过的 URL 清单 */
  failed: string[];
}

export interface BundleOptions {
  entries: MediaEntry[];
  /** zip 文件名（如「项目名-媒体-20260907-1530.zip」）；单文件时作基础名 */
  zipName: string;
  onProgress?: (done: number, total: number) => void;
}

/** 打包下载。0 个直接返回；1 个跳过 zip 直下；多个 fetch（4 路并发）后
 *  zipSync level 0 打包 + 清单.json。个别媒体拉取失败跳过不拦整批。 */
export async function downloadMediaBundle(opts: BundleOptions): Promise<BundleResult> {
  const { entries, zipName, onProgress } = opts;
  if (entries.length === 0) return { ok: 0, failed: [] };
  if (entries.length === 1) {
    const e = entries[0];
    await downloadMedia(e.url, `${sanitizeName(e.title) || "媒体"}-${e.nodeId.slice(0, 6)}.${extOf(e)}`);
    return { ok: 1, failed: [] };
  }

  const blobs = new Array<Blob | null>(entries.length).fill(null);
  let done = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      const i = cursor++;
      try {
        const res = await fetch(entries[i].url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blobs[i] = await res.blob();
      } catch {
        /* 失败跳过，清单里标注 */
      }
      done += 1;
      onProgress?.(done, entries.length);
    }
  });
  await Promise.all(workers);

  const files: Record<string, Uint8Array> = {};
  const manifest: {
    导出时间: string;
    文件: { 文件: string; 卡片: string; 类型: string; 节点: string; 来源: string; 状态: string }[];
  } = { 导出时间: new Date().toISOString(), 文件: [] };
  let ok = 0;
  const failed: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const name = bundleFileName(entries, i);
    const blob = blobs[i];
    if (!blob) {
      failed.push(e.url);
      manifest.文件.push({
        文件: name,
        卡片: e.title || "未命名",
        类型: e.nodeType,
        节点: e.nodeId,
        来源: e.url,
        状态: "拉取失败，未打包",
      });
      continue;
    }
    ok += 1;
    files[name] = new Uint8Array(await blob.arrayBuffer());
    manifest.文件.push({
      文件: name,
      卡片: e.title || "未命名",
      类型: e.nodeType,
      节点: e.nodeId,
      来源: e.url,
      状态: "ok",
    });
  }
  if (ok === 0) return { ok: 0, failed };
  files["清单.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(files, { level: 0 });
  saveBlob(new Blob([zipped], { type: "application/zip" }), zipName);
  return { ok, failed };
}

/** zip 名：{项目名}-媒体-{YYYYMMDD-HHmm}.zip */
export function bundleZipName(projectName: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const base = sanitizeName(projectName).slice(0, 40) || "画布媒体";
  return `${base}-媒体-${stamp}.zip`;
}
