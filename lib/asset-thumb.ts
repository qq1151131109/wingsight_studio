// 小尺寸展示一律走缩略图：/agent-service/assets/{name}.png → /agent-service/thumbs/{stem}.webp
// （agent 落盘即产 512px webp，缺失时端点现场自愈）；Lightbox 放大/下载才用原图。
// 非图片（视频/文档）与路径不匹配的 URL 原样返回。

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export function assetThumbUrl(url: string): string {
  const m = /\/agent-service\/assets\/([^/?#]+)$/.exec(url);
  if (!m || !IMAGE_EXT.test(m[1])) return url;
  const prefix = url.slice(0, m.index);
  return `${prefix}/agent-service/thumbs/${m[1].replace(/\.[^.]+$/, "")}.webp`;
}
