/**
 * 聊天消息「上下文段」契约回归（纯函数，无浏览器 / 无 LLM）。
 *
 * 2026-09-11：附件正文不再进对话记录显示，改由 `lib/chat/messageContext.ts` 的
 * 界标分隔——显示文本给界面，人话上下文给模型，JSON manifest 给 chip。本脚本
 * 锁住三件事：**模型侧一字不少**（正文/引用/失败明报照旧）、**manifest 不重复
 * 正文**、**解析健壮**（坏 manifest / 老消息不炸，退原样渲染）。
 *
 * 运行：pnpm dlx tsx scripts/chat-context-contract-test.mjs
 */
import {
  buildContextText,
  charsLabel,
  contextIsEmpty,
  contextSummary,
  CTX_MARK,
  MANIFEST_MARK,
  migrateLegacyUserContent,
  splitMessageContext,
  visibleUserText,
} from "../lib/chat/messageContext.ts";
import { contentToMarkdown } from "../lib/chat/content.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const BODY = "第4集：八仙饭店灭门案\n\n1985年8月8日，黑沙海滩发现漂浮残肢……唯一暗号ZQ7";
const ctx = {
  refs: [{ id: "n1", type: "character", title: "冯太后", snippet: "设定正文暗号A1" }],
  attachments: [
    { kind: "document", name: "八仙饭店.txt", nodeId: "n_doc", chars: 20000, body: BODY },
    { kind: "image", name: "参考图.png", url: "http://x/a.png" },
    { kind: "video", name: "片段.mp4", url: "http://x/v.mp4" },
    { kind: "audio", name: "配乐.mp3", url: "http://x/m.mp3" },
    { kind: "document", name: "坏文件.pdf", error: "未提取到文本" },
  ],
};

const text = buildContextText("根据文档生成资产图", ctx);

// ---------- A 组：模型侧一字不少 ----------
check("A1 显示文本在最前", text.startsWith("根据文档生成资产图"), text.slice(0, 20));
check("A2 带上下文界标", text.includes(CTX_MARK) && text.includes(MANIFEST_MARK));
check("A3 文档正文仍在（模型照旧能读到全文）", text.includes(BODY));
check("A4 引用行带 node id 与完整正文（不截断）", text.includes("- @n1 角色「冯太后」：设定正文暗号A1"));
check("A5 媒体附件行带 URL", text.includes("- 图片「参考图.png」：http://x/a.png"));
check("A6 失败附件如实明报", text.includes("- 文档「坏文件.pdf」上传失败，未附带（原因：未提取到文本）"));
check("A7 文档行标了资料卡与字数", text.includes("（资料卡 n_doc · 2.0 万字）内容："), 
  text.split("\n").find((l) => l.includes("资料卡")) ?? "(无)");

// ---------- B 组：manifest 不重复正文 ----------
const manifestRaw = text.slice(text.indexOf(MANIFEST_MARK) + MANIFEST_MARK.length);
const manifest = JSON.parse(manifestRaw);
check("B1 manifest 可 JSON 解析", Array.isArray(manifest.attachments) && manifest.refs.length === 1);
check(
  "B2 manifest 不带正文（正文只出现一次）",
  manifest.attachments.every((a) => !("body" in a)) &&
    text.split(BODY).length - 1 === 1,
  `正文出现 ${text.split(BODY).length - 1} 次`,
);
check(
  "B3 manifest 带 chip 需要的字段",
  manifest.attachments[0].nodeId === "n_doc" &&
    manifest.attachments[0].chars === 20000 &&
    manifest.attachments[1].url === "http://x/a.png" &&
    manifest.attachments[4].error === "未提取到文本",
);
check("B4 引用去掉了 snippet（界面不需要正文）", !("snippet" in manifest.refs[0]));

// ---------- C 组：解析 ----------
const back = splitMessageContext(text);
check("C1 往返：显示文本还原", back.text === "根据文档生成资产图", JSON.stringify(back.text));
check(
  "C2 往返：附件字段还原",
  back.ctx?.attachments.length === 5 &&
    back.ctx.attachments[0].kind === "document" &&
    back.ctx.attachments[0].name === "八仙饭店.txt" &&
    back.ctx.attachments[0].chars === 20000 &&
    back.ctx.attachments[3].kind === "audio",
);
check("C3 visibleUserText 不含正文", !visibleUserText(text).includes("ZQ7"));
check(
  "C4 contentToMarkdown 不导出正文，但列清单与媒体 URL",
  (() => {
    const md = contentToMarkdown([{ type: "text", text }]);
    return (
      md.startsWith("根据文档生成资产图") &&
      md.includes("[附件与引用]") &&
      md.includes("文档「八仙饭店.txt」") &&
      md.includes("- 图片：http://x/a.png") &&
      !md.includes("ZQ7")
    );
  })(),
);
check(
  "C5 老消息（无界标）退原样渲染，媒体 URL 照列",
  (() => {
    const legacy = [
      { type: "text", text: "看图" },
      { type: "image", source: { type: "url", value: "http://x/a.png" } },
    ];
    const r = splitMessageContext(legacy);
    return (
      r.ctx === null &&
      r.text === "看图" &&
      contentToMarkdown(legacy).includes("- 图片：http://x/a.png")
    );
  })(),
);
check(
  "C6 坏 manifest 不炸：ctx=null、显示文本仍干净",
  (() => {
    const broken = `你好\n\n${CTX_MARK}\n人话\n${MANIFEST_MARK}\n{oops`;
    const r = splitMessageContext(broken);
    return r.ctx === null && r.text === "你好";
  })(),
);
check(
  "C7 脏 manifest 项被丢弃（缺 name / 非法 kind）",
  (() => {
    const r = splitMessageContext(
      `x\n\n${CTX_MARK}\nh\n${MANIFEST_MARK}\n${JSON.stringify({
        refs: [{ id: "a", type: "note", title: "T" }, { type: "note" }],
        attachments: [{ kind: "zip", name: "a.zip" }, { kind: "image" }],
      })}`,
    );
    return r.ctx?.refs.length === 1 && r.ctx.attachments.length === 0;
  })(),
);

// ---------- D 组：边界 ----------
check("D1 空上下文 → 不加界标（消息保持纯净文本）", buildContextText("就一句", { refs: [], attachments: [] }) === "就一句");
check("D2 无文字只有附件 → 给人话兜底", buildContextText("", { refs: [], attachments: ctx.attachments }).includes("（用户未附带文字说明"));
check("D3 contextIsEmpty 口径", contextIsEmpty({ refs: [], attachments: [] }) && !contextIsEmpty({ refs: ctx.refs, attachments: [] }));
check("D4 字数说人话", charsLabel(20000) === "2.0 万字" && charsLabel(300) === "300 字");
check(
  "D5 一行摘要（轮次标签兜底 / 复制附注）",
  contextSummary(back.ctx) ===
    "文档「八仙饭店.txt」、图片「参考图.png」、视频「片段.mp4」、音频「配乐.mp3」、文档「坏文件.pdf」（失败）、角色「冯太后」",
  contextSummary(back.ctx),
);
check("D6 摘要对老消息为空串", contextSummary(null) === "");

// ---------- E 组：存量迁移（旧格式 → 新格式，正文一个字不丢）----------
const LEGACY_DOC = `（见附件与引用的画布卡片）

引用的画布卡片（可按 id 用 canvas_ops 操作）：
- @n_old 角色「冯太后」：设定正文暗号A1

附件：
- 文档「八仙饭店.txt」内容：
<<<
${BODY}
>>>
- 图片「参考图.png」：http://x/a.png（可作生成参考图）
- 视频「片段.mp4」：/agent-service/assets/abc.mp4
- 文档「坏文件.pdf」上传失败，未附带（原因：未提取到文本）`;
const migrated = migrateLegacyUserContent(LEGACY_DOC);
const mig = splitMessageContext(migrated);
check("E1 旧格式被迁移（带界标）", String(migrated).includes(CTX_MARK));
check(
  "E2 迁移后显示文本干净（占位句剥掉、管道文字不进气泡）",
  mig.text === "" && contextSummary(mig.ctx).includes("八仙饭店.txt"),
  `display=${JSON.stringify(mig.text)}`,
);
check(
  "E3 迁移后正文一个字不丢（模型侧照旧）",
  String(migrated).includes(BODY) && mig.ctx?.attachments[0].chars === BODY.length,
  `chars=${mig.ctx?.attachments[0].chars}`,
);
check(
  "E4 迁移保留引用与四类附件（含失败明报）",
  mig.ctx?.refs[0]?.id === "n_old" &&
    mig.ctx.attachments.length === 4 &&
    mig.ctx.attachments[1].url === "http://x/a.png" &&
    mig.ctx.attachments[2].kind === "video" &&
    mig.ctx.attachments[3].error === "未提取到文本",
  JSON.stringify(mig.ctx?.attachments?.map((a) => [a.kind, a.error ?? a.url ?? "doc"])),
);
check(
  "E5 迁移幂等（新格式再跑一次原样）",
  migrateLegacyUserContent(migrated) === migrated,
);
check("E6 非旧格式不动（普通一句话）", migrateLegacyUserContent("就一句") === "就一句");
check(
  "E7 正文里出现「附件：」字样不会被误迁（有界标的老消息）",
  (() => {
    const x = `正文\n\n${CTX_MARK}\nh\n${MANIFEST_MARK}\n{"attachments":[{"kind":"image","name":"a.png","url":"u"}]}`;
    return migrateLegacyUserContent(x) === x;
  })(),
);
check(
  "E8 迁移后仍能往返（split→build 等价）",
  (() => {
    const again = buildContextText(mig.text, mig.ctx);
    const r2 = splitMessageContext(again);
    return r2.text === mig.text && r2.ctx.attachments.length === mig.ctx.attachments.length;
  })(),
);

console.log(`\n${fail ? "✗" : "✅"} 上下文段契约 ${pass}/${pass + fail} 项通过`);
process.exit(fail ? 1 : 0);