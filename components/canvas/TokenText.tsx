"use client";

import { Fragment } from "react";

/** @图N 引用 token 高亮（对标 Storyboard-Copilot 的 referenceToken 染色）。
 *  从 nodes.tsx 抽出：Editable 展示态与 MarkdownView（markdown 渲染后的段落）
 *  共用，避免 nodes ↔ MarkdownView 循环引用 */
const REF_TOKEN_SPLIT = /(@图?\d+)/g;

export function TokenText({ text }: { text: string }) {
  const parts = text.split(REF_TOKEN_SPLIT);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        /^(@图?\d+)$/.test(p) ? (
          <span
            key={i}
            className="rounded bg-accent-dim px-0.5 font-medium text-accent"
          >
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
