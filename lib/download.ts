/** 媒体下载/复制工具（Lightbox 与视频灯箱共用）。
 *  a[download] 直连跨域 URL 会变成打开而非下载，统一 fetch 取 blob 再落盘；
 *  复制图片到剪贴板统一转 PNG（Safari 等只认 image/png 的 ClipboardItem） */

function extFromType(type: string): string {
  const t = type.split(";")[0].split("/")[1];
  return t ? t.replace("jpeg", "jpg").split("+")[0] : "";
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .slice(0, 19)
    .replace("T", "-")
    .replace(/:/g, "");
}

/** 下载 url 指向的图片/视频。filename 无扩展名时按响应类型补全并加时间戳防重名 */
export async function downloadMedia(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const base = sanitizeName(filename) || "image";
  const name = /\.[a-z0-9]{2,5}$/i.test(base)
    ? base
    : `${base}-${timestamp()}.${extFromType(blob.type) || "png"}`;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

/** 复制图片到剪贴板：非 PNG 先经 canvas 转码 */
export async function copyImageToClipboard(url: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("浏览器不支持");
  }
  const blob = await (await fetch(url)).blob();
  let png = blob;
  if (blob.type !== "image/png") {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")?.drawImage(bmp, 0, 0);
    png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("转码失败"))),
        "image/png",
      );
    });
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** 复制图片链接（相对路径转绝对再复制） */
export async function copyImageUrl(url: string): Promise<void> {
  await navigator.clipboard.writeText(new URL(url, location.href).href);
}
