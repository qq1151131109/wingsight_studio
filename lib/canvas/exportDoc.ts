/**
 * 文本类卡导出（txt / md / docx）：纯前端产物，不经服务端。
 *  - 文本/剧本卡：txt/md = 正文原样；docx = 标题 + 正文分段
 *  - 分镜表卡：txt/md 每镜一节；docx 横版表格（制片交付惯例，表头跨页重复）
 * docx 包走动态 import——画布首屏不背这份包，点导出时才拉取。
 * 这里收口 OOXML 细节（中文字体/横版页/列宽），调用方只描述内容。
 */

import type { ShotRow } from "@/lib/canvas/store";

export type ExportFormat = "txt" | "md" | "docx";

/** 导出文件名：剥文件系统非法字符，截 40 字；空标题由调用方给业务回落名 */
export function exportFileName(title: string, ext: string): string {
  const safe = (title || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 40);
  return `${safe || "wingsight"}.${ext}`;
}

function downloadBlob(name: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 文本类导出（txt/md）：内容原样落文件 */
export function exportTextFile(
  title: string,
  content: string,
  ext: "txt" | "md",
): void {
  const mime = ext === "md" ? "text/markdown" : "text/plain";
  downloadBlob(
    exportFileName(title, ext),
    new Blob([content], { type: `${mime};charset=utf-8` }),
  );
}

/** docx 内容的中间表示：h1/h2 标题、段落、表格（列宽 twips） */
export type ExportDocxBlock =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string }
  | { kind: "table"; header: string[]; rows: string[][]; widths: number[] };

/** 生成并下载 docx。表头行跨页自动重复；单元格文本按 \n 拆多段 */
export async function exportDocxFile(
  title: string,
  blocks: ExportDocxBlock[],
  opts?: { landscape?: boolean },
): Promise<void> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    PageOrientation,
    TableLayoutType,
  } = await import("docx");
  // 中文正文默认字体（ascii 交回西文字体），五号 10.5pt
  const cjk = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" };
  const children = blocks.map((b) => {
    if (b.kind === "h1" || b.kind === "h2") {
      return new Paragraph({
        text: b.text,
        heading:
          b.kind === "h1" ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
      });
    }
    if (b.kind === "p") return new Paragraph({ text: b.text });
    const headerRow = new TableRow({
      tableHeader: true,
      children: b.header.map(
        (text, i) =>
          new TableCell({
            width: { size: b.widths[i], type: WidthType.DXA },
            shading: { fill: "F1ECE2" },
            children: [
              new Paragraph({ children: [new TextRun({ text, bold: true })] }),
            ],
          }),
      ),
    });
    const bodyRows = b.rows.map((cells) =>
      new TableRow({
        children: cells.map(
          (text, i) =>
            new TableCell({
              width: { size: b.widths[i], type: WidthType.DXA },
              children: text
                .split("\n")
                .map((seg) => new Paragraph({ text: seg })),
            }),
        ),
      }),
    );
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: b.widths,
      layout: TableLayoutType.FIXED,
      rows: [headerRow, ...bodyRows],
    });
  });
  // A4（twips）：横版交换宽高
  const size = opts?.landscape
    ? { width: 16838, height: 11906, orientation: PageOrientation.LANDSCAPE }
    : undefined;
  const doc = new Document({
    styles: { default: { document: { run: { font: cjk, size: 21 } } } },
    sections: [{ properties: size ? { page: { size } } : undefined, children }],
  });
  downloadBlob(exportFileName(title, "docx"), await Packer.toBlob(doc));
}

/** 文本/剧本卡 docx 内容：标题 + 正文逐行分段 */
export function textToDocxBlocks(title: string, body: string): ExportDocxBlock[] {
  const blocks: ExportDocxBlock[] = [];
  if (title.trim()) blocks.push({ kind: "h1", text: title.trim() });
  for (const line of body.split("\n")) blocks.push({ kind: "p", text: line });
  return blocks;
}

const SHOT_FIELD_LABELS: [keyof ShotRow, string][] = [
  ["action", "画面"],
  // UI 里该字段标签是「旁白」（placeholder 台词/旁白），flow 语义也是台词或
  // 旁白共用一字段——导出沿用「台词/旁白」，别标成单「台词」（会像丢了旁白）
  ["dialogue", "台词/旁白"],
  ["lighting", "光影"],
  ["sound", "音效"],
  ["finalPrompt", "提示词"],
];

function shotHeadline(r: ShotRow): string {
  return [r.shotSize, r.cameraMove, r.duration]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

/** 总时长概算：口径与卡面 totalDur 同源（duration 字符串抽数值，LLM 可能给数字型） */
function shotlistMetaLine(rows: ShotRow[]): string {
  const total = rows.reduce((sum, r) => {
    const m = String(r.duration ?? "").match(/(\d+(?:\.\d+)?)/);
    return sum + (m ? parseFloat(m[1]) : 0);
  }, 0);
  const dur = total > 0 ? ` · 总时长约 ${Math.round(total * 10) / 10}s` : "";
  return `共 ${rows.length} 镜${dur}`;
}

function shotFieldLines(r: ShotRow): string[] {
  const lines: string[] = [];
  for (const [key, label] of SHOT_FIELD_LABELS) {
    const v = String(r[key] ?? "").trim();
    if (v) lines.push(`${label}：${v}`);
  }
  return lines;
}

/** 分镜表 → Markdown（每镜一节，表格单元格塞长文会碎，不用 md 表格） */
export function shotlistToMarkdown(
  title: string,
  rows: ShotRow[],
  visualStyle?: string,
): string {
  const parts: string[] = [`# ${title}`, `> ${shotlistMetaLine(rows)}`];
  if (visualStyle?.trim()) parts.push(`> 视觉风格：${visualStyle.trim()}`);
  rows.forEach((r, i) => {
    const head = [`镜${i + 1}`, shotHeadline(r)].filter(Boolean).join(" · ");
    parts.push(`## ${head}`);
    const fields = shotFieldLines(r);
    if (fields.length) parts.push(fields.map((l) => `- ${l}`).join("\n"));
  });
  return parts.join("\n\n") + "\n";
}

/** 分镜表 → 纯文本（镜节之间空行分隔） */
export function shotlistToText(
  title: string,
  rows: ShotRow[],
  visualStyle?: string,
): string {
  const parts: string[] = [title, shotlistMetaLine(rows)];
  if (visualStyle?.trim()) parts.push(`视觉风格：${visualStyle.trim()}`);
  rows.forEach((r, i) => {
    const head = [`镜${i + 1}`, shotHeadline(r)].filter(Boolean).join("  ");
    parts.push([`【${head}】`, ...shotFieldLines(r)].join("\n"));
  });
  return parts.join("\n\n") + "\n";
}

/** 分镜表 → docx 横版表格（9 列：镜号/景别/运镜/时长/画面/台词/光影/音效/提示词；
 *  列宽按内容配比，合计 A4 横版可用宽 16838 − 2×1440 = 13958 twips） */
export function shotlistToDocxBlocks(
  title: string,
  rows: ShotRow[],
  visualStyle?: string,
): ExportDocxBlock[] {
  const blocks: ExportDocxBlock[] = [{ kind: "h1", text: title }];
  blocks.push({ kind: "p", text: shotlistMetaLine(rows) });
  if (visualStyle?.trim())
    blocks.push({ kind: "p", text: `视觉风格：${visualStyle.trim()}` });
  blocks.push({
    kind: "table",
    header: ["镜号", "景别", "运镜", "时长", "画面", "台词/旁白", "光影", "音效", "提示词"],
    widths: [700, 1000, 1000, 850, 3400, 2300, 1500, 1500, 1708],
    rows: rows.map((r, i) => [
      String(i + 1),
      (r.shotSize ?? "").trim(),
      (r.cameraMove ?? "").trim(),
      (r.duration ?? "").trim(),
      (r.action ?? "").trim(),
      (r.dialogue ?? "").trim(),
      (r.lighting ?? "").trim(),
      (r.sound ?? "").trim(),
      (r.finalPrompt ?? "").trim(),
    ]),
  });
  return blocks;
}
