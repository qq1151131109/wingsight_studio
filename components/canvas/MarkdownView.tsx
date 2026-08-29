"use client";

/**
 * 卡片正文的 Markdown 只读渲染（对标 Storyboard-Copilot / open-storyboard
 * 的非编辑态预览）：GFM（表格/删除线/任务列表）+ 单换行即 <br>。
 * 段落/列表/标题内的文本仍走 TokenText，@图N 引用高亮不丢。
 * 编辑态保持纯文本源码——"编辑源码、失焦出排版"与竞品一致。
 */

import { Fragment, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { TokenText } from "./TokenText";

/** 递归把字符串子节点换成 @图N 高亮（嵌套在 strong/em 里也覆盖） */
function withTokens(children: ReactNode): ReactNode {
  if (typeof children === "string") return <TokenText text={children} />;
  if (Array.isArray(children))
    return children.map((c, i) => <Fragment key={i}>{withTokens(c)}</Fragment>);
  return children;
}

const MD_COMPONENTS: Components = {
  p: ({ children }) => <p>{withTokens(children)}</p>,
  li: ({ children }) => <li>{withTokens(children)}</li>,
  h1: ({ children }) => <h1>{withTokens(children)}</h1>,
  h2: ({ children }) => <h2>{withTokens(children)}</h2>,
  h3: ({ children }) => <h3>{withTokens(children)}</h3>,
  h4: ({ children }) => <h4>{withTokens(children)}</h4>,
  h5: ({ children }) => <h5>{withTokens(children)}</h5>,
  h6: ({ children }) => <h6>{withTokens(children)}</h6>,
  blockquote: ({ children }) => (
    <blockquote>{withTokens(children)}</blockquote>
  ),
  td: ({ children }) => <td>{withTokens(children)}</td>,
  th: ({ children }) => <th>{withTokens(children)}</th>,
  strong: ({ children }) => <strong>{withTokens(children)}</strong>,
  em: ({ children }) => <em>{withTokens(children)}</em>,
  del: ({ children }) => <del>{withTokens(children)}</del>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export default function MarkdownView({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`ws-md ${className ?? ""}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
