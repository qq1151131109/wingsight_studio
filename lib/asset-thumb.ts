// 资产原图 3~7MB（2K/4K PNG 直出），小尺寸展示一律换 /thumbs 的 webp 缩略图；
// 放大（Lightbox）、下载、对比等需要原始分辨率的场景继续用原 URL。
// 原图文件名是随机 hex 内容不可变，缩略图同样可被 immutable 长缓存。
//
// 两档：thumbs 512 长边（常规缩放）；previews 1600 长边（hires 放大态——
// 此前放大直接拉原图，maxZoom=4 + DPR2 下 zoom>1.05 就触发，单张 3~7MB）。
const ASSET_PREFIX = "/agent-service/assets/";

function stemOf(url: string): string | null {
  if (!url.startsWith(ASSET_PREFIX)) return null;
  const name = url.slice(ASSET_PREFIX.length).split(/[?#]/)[0];
  return name.includes(".") ? name.replace(/\.[^.]+$/, "") : name;
}

export function assetThumbUrl(url: string): string {
  const stem = stemOf(url);
  return stem === null ? url : `/agent-service/thumbs/${stem}.webp`;
}

/** 放大态展示用（1600 长边）；需要原始分辨率仍用原 URL */
export function assetPreviewUrl(url: string): string {
  const stem = stemOf(url);
  return stem === null ? url : `/agent-service/previews/${stem}.webp`;
}
