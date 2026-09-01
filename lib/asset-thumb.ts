// 资产原图 3~7MB（2K/4K PNG 直出），小尺寸展示一律换 /thumbs 的 webp 缩略图；
// 放大（Lightbox）、下载、对比等需要原始分辨率的场景继续用原 URL。
// 原图文件名是随机 hex 内容不可变，缩略图同样可被 immutable 长缓存。
const ASSET_PREFIX = "/agent-service/assets/";

export function assetThumbUrl(url: string): string {
  if (!url.startsWith(ASSET_PREFIX)) return url;
  const name = url.slice(ASSET_PREFIX.length).split(/[?#]/)[0];
  const stem = name.includes(".") ? name.replace(/\.[^.]+$/, "") : name;
  return `/agent-service/thumbs/${stem}.webp`;
}
