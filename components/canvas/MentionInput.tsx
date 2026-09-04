"use client";

/**
 * 内联 @ 引用输入框（open-ai-canvas 结构化 token 范式）。
 *
 * 正文即引用载体：@ 触发候选弹层，选中后在光标处插入 chip（contenteditable=false
 * 的 span，data-mention-id 指向节点）。提交时才序列化编号——带图引用按首现
 * 顺序编为 图1..图N（同卡多次 @ 同号），无图引用（文本/剧本卡）落成《标题》；
 * token 存的是节点 id，引用增删不会让指代漂移。这解决了旧版「引用只挂上方
 * chip、正文指代词全靠手写」的脱节问题。
 *
 * 实现边界：Enter=换行（pre-wrap 文本节点内插 \n，DOM 只含文本节点+chip 两种）；
 * Backspace/Delete 整颗 chip 删除；粘贴降级纯文本；中文 IME 组合期间不做 @ 检测。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  NODE_META,
  useCanvasStore,
  type WingNode,
  type WingNodeType,
} from "@/lib/canvas/store";
import { assetThumbUrl } from "@/lib/asset-thumb";
import { FOCUS_NODES_EVENT } from "@/lib/canvas/events";

export type MentionRead = {
  /** 生成用正文：带图 chip→图N（按首现顺序编号），无图 chip→《标题》 */
  prompt: string;
  /** 展示形态：chip→@标题（收藏/判空用） */
  display: string;
  /** 被 @ 的节点 id，按首现顺序去重（含无图引用） */
  mentionIds: string[];
  /** 其中有图的引用 id（= 图N 编号顺序，桥接层据此对齐参考图数组） */
  imageRefIds: string[];
  /** 正文与引用全空 */
  empty: boolean;
};

export type MentionInputHandle = {
  focus: () => void;
  read: () => MentionRead;
  /** 整体替换为纯文本（AI 辅助回填/清空/预填） */
  setValue: (text: string) => void;
  /** 在末尾追加一颗引用 chip（拖卡进面板的快捷通道） */
  appendMention: (nodeId: string) => void;
  /** 删掉光标前 n 个字符（宿主 /slash 菜单选用后抠查询词用） */
  deleteBeforeCaret: (nChars: number) => void;
  /** 光标处插入纯文本 */
  insertAtCaret: (text: string) => void;
};

type Trigger = { textNode: Text; at: number; q: string };

/** 候选分桶轮转的类型顺序：角色最前（一致性主场景），随后有图生产类、
 *  文本类、媒体类；桶内带图优先 */
const TYPE_ORDER_KEYS = [
  "character",
  "image",
  "scene",
  "prop",
  "costume",
  "storyboard",
  "script",
  "note",
  "video",
  "audio",
  "compose",
];

function isMentionEl(n: Node | null | undefined): n is HTMLSpanElement {
  return n instanceof HTMLSpanElement && Boolean(n.dataset.mentionId);
}

/** caret 前的 @ 触发片段（限定纯文本节点内，chip 不可编辑所以天然是边界） */
function detectTrigger(ed: HTMLDivElement | null): Trigger | null {
  if (!ed) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const an = sel.anchorNode;
  if (!an || an.nodeType !== Node.TEXT_NODE || !ed.contains(an)) return null;
  const off = sel.anchorOffset;
  const m = (an.textContent ?? "").slice(0, off).match(/@([^\s@]{0,20})$/);
  if (!m) return null;
  return { textNode: an as Text, at: off - m[0].length, q: m[1] };
}

function buildMentionSpan(n: WingNode): HTMLSpanElement {
  const span = document.createElement("span");
  fillMentionSpan(span, n);
  return span;
}

/** chip 内容按节点现状填充：改名/换图后重复调用即可同步（渲染时解析派，
 *  chip 只是 token 的皮，token 本身只存 id） */
function fillMentionSpan(span: HTMLSpanElement, n: WingNode) {
  span.className = "ws-mention";
  span.contentEditable = "false";
  span.dataset.mentionId = n.id;
  const url = n.data.imageUrl as string | undefined;
  const label = document.createElement("span");
  label.textContent = `@${(n.data.title || "无题").slice(0, 10)}`;
  span.replaceChildren();
  if (url) {
    const img = document.createElement("img");
    img.src = assetThumbUrl(url);
    img.alt = "";
    span.appendChild(img);
  } else {
    const badge = document.createElement("span");
    const meta = NODE_META[n.data.nodeType];
    badge.textContent = meta?.label?.slice(0, 1) ?? "?";
    if (meta?.dot) badge.style.color = meta.dot;
    span.appendChild(badge);
  }
  span.appendChild(label);
}

function placeCaret(ed: HTMLDivElement, offset: number) {
  const r = document.createRange();
  r.setStart(ed, Math.min(offset, ed.childNodes.length));
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

/** caret 在纯文本坐标里的偏移（对 textContent 计数，宿主做 /slash 等自检用） */
function caretOffset(ed: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const an = sel.anchorNode;
  if (!an || !ed.contains(an)) return 0;
  let total = 0;
  const found = (function walk(node: Node): boolean {
    if (node === an) {
      total += sel.anchorOffset;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      total += node.textContent?.length ?? 0;
      return false;
    }
    for (const c of Array.from(node.childNodes)) if (walk(c)) return true;
    return false;
  })(ed);
  return found ? total : 0;
}

function caretToEnd(ed: HTMLDivElement) {
  ed.focus();
  const r = document.createRange();
  r.selectNodeContents(ed);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

/** 序列化：图N 编号在这里现场生成（token 只存 id，增删引用不漂移） */
function readEditor(ed: HTMLDivElement): MentionRead {
  const nodes = useCanvasStore.getState().nodes;
  const mentionIds: string[] = [];
  const imageRefIds: string[] = [];
  let prompt = "";
  let display = "";
  for (const n of Array.from(ed.childNodes)) {
    if (isMentionEl(n)) {
      const id = n.dataset.mentionId as string;
      const node = nodes.find((x) => x.id === id);
      // 幽灵 chip（引用的卡已删除）：序列化直接跳过——不往提示词塞《无题》、
      // 不把死 id 传给 refIds；视觉上保留灰 chip 由用户自行删除
      if (!node) continue;
      const title = node.data.title || "无题";
      if (!mentionIds.includes(id)) mentionIds.push(id);
      if (node.data.imageUrl) {
        if (!imageRefIds.includes(id)) imageRefIds.push(id);
        prompt += `图${imageRefIds.indexOf(id) + 1}`;
      } else {
        prompt += `《${title}》`;
      }
      display += `@${title.slice(0, 12)}`;
    } else {
      prompt += n.textContent ?? "";
      display += n.textContent ?? "";
    }
  }
  return {
    prompt: prompt.trim(),
    display: display.trim(),
    mentionIds,
    imageRefIds,
    empty: !prompt.trim() && mentionIds.length === 0,
  };
}

type Props = {
  /** 当前节点（画布面板场景）：带图时本卡进候选并钉顶；聊天侧无当前节点可省 */
  nodeId?: string;
  /** 当前节点的上游连线卡 id（画布面板场景传）：候选里「已连线」置顶组——
   *  连线即参考，@ 候选必须让用户找得到已连线的卡（罪案实录事故） */
  connectedIds?: string[];
  placeholder?: string;
  initialText?: string;
  minHeight: number;
  maxHeight: number;
  /** 内容（含 chip 增删）变化时回吐序列化结果 */
  onChange?: (r: MentionRead) => void;
  /** 光标/内容变化时回吐纯文本与 caret 偏移（宿主自检其它触发符，如 /slash） */
  onCaret?: (info: { text: string; caret: number }) => void;
  /** true = 裸 Enter 提交（onSubmit），Shift+Enter 换行（聊天侧）；
   *  false（默认）= Enter 换行，Ctrl/Cmd+Enter 提交（画布面板） */
  enterToSubmit?: boolean;
  /** 宿主附加类名（样式兼容用） */
  className?: string;
  /** Ctrl/Cmd+Enter（父层提交生成） */
  onSubmit?: () => void;
};

const MentionInput = forwardRef<MentionInputHandle, Props>(function MentionInput(
  {
    nodeId,
    connectedIds,
    placeholder,
    initialText,
    minHeight,
    maxHeight,
    onChange,
    onCaret,
    enterToSubmit = false,
    className,
    onSubmit,
  },
  ref,
) {
  const edRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const cbRef = useRef(onChange);
  useEffect(() => {
    cbRef.current = onChange;
  });
  const caretCbRef = useRef(onCaret);
  useEffect(() => {
    caretCbRef.current = onCaret;
  });
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [hi, setHi] = useState(0);
  // 弹层分组 tab + 组内搜索（←→ 切组、输入过滤）
  const [tabIdx, setTabIdx] = useState(0);
  const [searchQ, setSearchQ] = useState("");
  const [stats, setStats] = useState<{ tokenIds: string[]; empty: boolean }>({
    tokenIds: [],
    empty: !initialText,
  });

  const nodes = useCanvasStore((s) => s.nodes);

  // 初始内容只在挂载时落一次（useState 初始化器冻结）：dangerouslySetInnerHTML
  // 的 __html 若随 draft 变化，React 会在每次重渲染时整体重写 innerHTML，
  // 抹掉手插的 chip
  const [initHtml] = useState(() =>
    (initialText ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string),
  );

  const emitChange = useCallback(() => {
    const ed = edRef.current;
    if (!ed) return;
    // 内容清空后浏览器可能残留空节点，:empty 占位会失效，现场规整
    if (!ed.textContent && ed.querySelector(".ws-mention") === null && ed.childNodes.length > 0) {
      ed.textContent = "";
    }
    const r = readEditor(ed);
    setStats({ tokenIds: r.mentionIds, empty: r.empty });
    cbRef.current?.(r);
  }, []);

  useEffect(() => {
    emitChange();
    // 仅挂载时回吐一次初值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncTrigger = useCallback(() => {
    const ed = edRef.current;
    if (!ed) return;
    if (!composingRef.current) {
      setTrigger(detectTrigger(ed));
      setHi(0);
      caretCbRef.current?.({ text: ed.textContent ?? "", caret: caretOffset(ed) });
    }
  }, []);

  const resize = useCallback(() => {
    const ed = edRef.current;
    if (!ed) return;
    ed.style.height = "auto";
    ed.style.height = `${Math.min(ed.scrollHeight, maxHeight)}px`;
  }, [maxHeight]);
  useEffect(() => {
    resize();
  }, [stats, resize]);

  // chip 与节点数据同步（渲染时解析派）：改名/换图/删除实时反映到正文 chip，
  // 已删除的加幽灵态——token 本身只存 id，此处只是刷新皮
  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    ed.querySelectorAll<HTMLSpanElement>(".ws-mention").forEach((span) => {
      const n = nodes.find((x) => x.id === span.dataset.mentionId);
      if (!n) {
        span.classList.add("ws-mention-ghost");
        span.title = "该卡已删除，生成时将被忽略";
        return;
      }
      span.classList.remove("ws-mention-ghost");
      span.title = `${n.data.title || "无题"}（点击定位画布卡片）`;
      // 拖动节点时 nodes 每帧换引用：内容没变就别重建（防无谓 DOM 抖动）
      const label = `@${(n.data.title || "无题").slice(0, 10)}`;
      const url = n.data.imageUrl as string | undefined;
      const img = span.querySelector("img");
      const unchanged =
        span.lastElementChild?.textContent === label &&
        (url ? img?.getAttribute("src") === assetThumbUrl(url) : !img);
      if (!unchanged) fillMentionSpan(span, n);
    });
  }, [nodes]);

  /** 候选分组（参与来源分组范式）：本卡 / 已连线 / 按类型分桶。桶内带图
   *  优先；分组+搜索替代旧「分桶轮转截 24」——后建卡被挤出列表的罪案
   *  实录事故根因不再靠配额缓解，用户按 tab 直达 */
  const groups = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.q.toLowerCase();
    const match = (n: WingNode) =>
      !q ||
      (n.data.title ?? "").toLowerCase().includes(q) ||
      (n.data.body ?? "").slice(0, 120).toLowerCase().includes(q);
    // @ 自己：带图才候选（图生图迭代锚点，open-ai-canvas includeSelf 范式）
    const self =
      nodeId !== undefined && stats.tokenIds.includes(nodeId)
        ? null
        : nodes.find(
            (n) => n.id === nodeId && Boolean(n.data.imageUrl) && match(n),
          ) ?? null;
    // 已连线置顶组（ai-moive 上游分组范式）：连线即参考，永远可 @ 到
    const connected = (connectedIds ?? [])
      .map((id) => nodes.find((n) => n.id === id))
      .filter(
        (n): n is WingNode =>
          Boolean(n) &&
          n!.id !== nodeId &&
          !stats.tokenIds.includes(n!.id) &&
          Boolean(n!.data?.nodeType) &&
          match(n!),
      );
    const rest = nodes.filter((n) => {
      if (n.id === nodeId) return false;
      if (!n.data?.nodeType || n.data.nodeType === "group") return false;
      if (stats.tokenIds.includes(n.id)) return false;
      if (connectedIds?.includes(n.id)) return false;
      return match(n);
    });
    const byType = new Map<string, WingNode[]>();
    for (const n of rest) {
      const t = String(n.data.nodeType);
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(n);
    }
    for (const arr of byType.values())
      arr.sort(
        (a, b) =>
          Number(Boolean(b.data.imageUrl)) - Number(Boolean(a.data.imageUrl)),
      );
    const out: { key: string; label: string; nodes: WingNode[] }[] = [];
    if (self) out.push({ key: "self", label: "本卡", nodes: [self] });
    if (connected.length)
      out.push({ key: "connected", label: `已连线 ${connected.length}`, nodes: connected });
    for (const t of TYPE_ORDER_KEYS) {
      const arr = byType.get(t);
      if (arr?.length)
        out.push({
          key: t,
          label: `${NODE_META[t as WingNodeType]?.label ?? t} ${arr.length}`,
          nodes: arr.slice(0, 50),
        });
    }
    return out;
  }, [nodes, trigger, stats.tokenIds, nodeId, connectedIds]);

  // 搜索过滤（组内，标题+正文）；有过滤词时空组隐藏，保持 tab 行干净
  const visibleGroups = useMemo(() => {
    const sq = searchQ.trim().toLowerCase();
    const out = groups.map((g) => ({
      ...g,
      nodes: sq
        ? g.nodes.filter(
            (n) =>
              (n.data.title ?? "").toLowerCase().includes(sq) ||
              ((n.data.body as string) ?? "").slice(0, 200).toLowerCase().includes(sq),
          )
        : g.nodes,
    }));
    return sq ? out.filter((g) => g.nodes.length > 0) : out;
  }, [groups, searchQ]);
  const tab = Math.min(tabIdx, Math.max(0, visibleGroups.length - 1));
  const curNodes = visibleGroups[tab]?.nodes ?? [];
  const hiClamped = curNodes.length ? Math.min(hi, curNodes.length - 1) : 0;

  // 新一次 @ 触发（null→开）时复位 tab/搜索；打字细化查询词不动已选 tab
  const prevTriggerRef = useRef<Trigger | null>(null);
  useEffect(() => {
    if (trigger && !prevTriggerRef.current) {
      setTabIdx(0);
      setSearchQ("");
      setHi(0);
    }
    prevTriggerRef.current = trigger;
  }, [trigger]);

  // 高亮项滚入可视区（键盘导航跨出列表窗口时跟随）
  const hiRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    hiRef.current?.scrollIntoView({ block: "nearest" });
  }, [hiClamped, tab]);

  /** 弹层键盘导航（编辑器与搜索框共用）：←→ 切组、↑↓ 组内循环、Enter
   *  拾取。返回 true 表示已消费 */
  const handleNavKey = (e: React.KeyboardEvent): boolean => {
    if (!trigger) return false;
    if (e.key === "ArrowRight" && visibleGroups.length > 1) {
      e.preventDefault();
      setTabIdx((tab + 1) % visibleGroups.length);
      setHi(0);
      return true;
    }
    if (e.key === "ArrowLeft" && visibleGroups.length > 1) {
      e.preventDefault();
      setTabIdx((tab - 1 + visibleGroups.length) % visibleGroups.length);
      setHi(0);
      return true;
    }
    if (curNodes.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((hiClamped + 1) % curNodes.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((hiClamped - 1 + curNodes.length) % curNodes.length);
      return true;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      pick(curNodes[hiClamped]);
      return true;
    }
    return false;
  };

  const pick = useCallback(
    (n: WingNode) => {
      const ed = edRef.current;
      if (!ed) return;
      const t = trigger && ed.contains(trigger.textNode) ? trigger : null;
      if (!t) return;
      // 抠掉 "@查询词" 文本，原位插 chip（DOM 保持 文本节点+chip 两种）
      const after = t.textNode.splitText(t.at);
      after.textContent = (after.textContent ?? "").slice(1 + t.q.length);
      const span = buildMentionSpan(n);
      t.textNode.parentNode?.insertBefore(span, after);
      if (!after.textContent) after.remove();
      const r = document.createRange();
      r.setStartAfter(span);
      r.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      ed.focus();
      setTrigger(null);
      emitChange();
    },
    [trigger, emitChange],
  );

  /** Backspace/Delete 整颗 chip 删除（逐字符删 chip 内文本是灾难） */
  const tryDeleteToken = useCallback((dir: "back" | "fwd"): boolean => {
    const ed = edRef.current;
    if (!ed) return false;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
    const an = sel.anchorNode;
    if (!an || !ed.contains(an)) return false;
    let token: HTMLSpanElement | null = null;
    let caret: () => void = () => {};
    if (an.nodeType === Node.TEXT_NODE) {
      const t = an as Text;
      if (dir === "back" && sel.anchorOffset === 0 && isMentionEl(t.previousSibling)) {
        token = t.previousSibling;
        caret = () =>
          placeCaret(ed, Array.from(ed.childNodes).indexOf(an as ChildNode));
      } else if (
        dir === "fwd" &&
        sel.anchorOffset === (t.textContent?.length ?? 0) &&
        isMentionEl(t.nextSibling)
      ) {
        token = t.nextSibling;
        caret = () =>
          placeCaret(ed, Array.from(ed.childNodes).indexOf(an as ChildNode) + 1);
      }
    } else if (an === ed) {
      const idx = sel.anchorOffset;
      const target = dir === "back" ? ed.childNodes[idx - 1] : ed.childNodes[idx];
      if (isMentionEl(target)) {
        token = target;
        const at = dir === "back" ? idx - 1 : idx;
        caret = () => placeCaret(ed, at);
      }
    }
    if (!token) return false;
    token.remove();
    caret();
    emitChange();
    return true;
  }, [emitChange]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (edRef.current) caretToEnd(edRef.current);
      },
      read: () =>
        readEditor(edRef.current ?? document.createElement("div")),
      setValue: (text: string) => {
        const ed = edRef.current;
        if (!ed) return;
        ed.textContent = text;
        setTrigger(null);
        caretToEnd(ed);
        emitChange();
      },
      appendMention: (otherId: string) => {
        const ed = edRef.current;
        const n = useCanvasStore.getState().nodes.find((x) => x.id === otherId);
        if (!ed || !n) return;
        if ((readEditor(ed).mentionIds ?? []).includes(otherId)) return;
        const needsSpace =
          ed.childNodes.length > 0 &&
          !/\s$/.test(ed.textContent ?? "") &&
          !(ed.lastChild instanceof HTMLSpanElement && (ed.lastChild as HTMLSpanElement).dataset.mentionId);
        if (needsSpace) ed.appendChild(document.createTextNode(" "));
        ed.appendChild(buildMentionSpan(n));
        caretToEnd(ed);
        emitChange();
      },
      /** 删掉光标前 n 个字符（宿主 /slash 菜单选用后抠查询词用） */
      deleteBeforeCaret: (nChars: number) => {
        const ed = edRef.current;
        if (!ed || nChars <= 0) return;
        ed.focus();
        const sel = window.getSelection();
        const an = sel?.anchorNode;
        if (!sel || sel.rangeCount === 0 || !an || an.nodeType !== Node.TEXT_NODE || !ed.contains(an))
          return;
        const off = sel.anchorOffset;
        const start = Math.max(0, off - nChars);
        (an as Text).deleteData(start, off - start);
        const r = document.createRange();
        r.setStart(an, start);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        emitChange();
      },
      /** 光标处插入纯文本 */
      insertAtCaret: (text: string) => {
        const ed = edRef.current;
        if (!ed) return;
        ed.focus();
        document.execCommand("insertText", false, text);
        emitChange();
      },
    }),
    [emitChange],
  );

  return (
    <div className="relative">
      <div
        ref={edRef}
        role="textbox"
        aria-multiline="true"
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className={`ws-mention-input w-full overflow-y-auto bg-transparent leading-relaxed text-text outline-none ${
          minHeight >= 80 ? "px-1 py-1 text-sm" : "px-1 py-0.5 text-xs"
        } ${className ?? ""}`}
        style={{ minHeight, maxHeight }}
        onInput={() => {
          syncTrigger();
          // 打字必须回吐 onChange（宿主的发送键/提交都读 MentionRead）；
          // IME 组合中不动——compositionEnd 统一回吐，避免打断组词
          if (!composingRef.current) emitChange();
        }}
        onClick={(e) => {
          // 点 chip = 定位并选中画布卡片（ai-moive/viedeo-workflow 范式）
          const el = (e.target as HTMLElement).closest?.(".ws-mention");
          const mid = el instanceof HTMLSpanElement ? el.dataset.mentionId : undefined;
          if (mid) {
            const st = useCanvasStore.getState();
            st.selectNodes([mid]);
            window.dispatchEvent(
              new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [mid] } }),
            );
          }
          syncTrigger();
        }}
        onKeyUp={(e) => {
          // 弹层导航键（↑↓/Enter/Esc）的 keydown 已处理高亮与选中有果；
          // keyup 再 syncTrigger 会 setHi(0) 把高亮弹回首项——「方向键没
          // 反应」的根因。左右方向键移动光标会改变 @ 触发上下文，仍重算
          if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(e.key)) return;
          syncTrigger();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          syncTrigger();
          emitChange();
        }}
        onPaste={(e) => {
          // 富文本粘贴会带进不可控标签，降级纯文本（DOM 只认文本+chip）
          e.preventDefault();
          const t = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, t);
        }}
        onDrop={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          // IME 组合中的 Enter 是选字确认，编辑器层面不抢
          if (e.nativeEvent.isComposing) return;
          if (trigger && handleNavKey(e)) return;
          if (e.key === "Escape") {
            e.stopPropagation();
            setTrigger(null);
            return;
          }
          if (e.key === "Enter") {
            // enterToSubmit（聊天侧）：裸 Enter 提交、Shift+Enter 换行；
            // 默认（画布面板）：Enter 换行、Ctrl/Cmd+Enter 提交
            const submitHit = enterToSubmit ? !e.shiftKey : e.ctrlKey || e.metaKey;
            e.preventDefault();
            if (submitHit) {
              onSubmit?.();
              return;
            }
            // \n 进同一文本节点（pre-wrap），DOM 结构保持只有 文本+chip
            document.execCommand("insertText", false, "\n");
            return;
          }
          if (e.key === "Backspace" && tryDeleteToken("back")) {
            e.preventDefault();
            return;
          }
          if (e.key === "Delete" && tryDeleteToken("fwd")) {
            e.preventDefault();
          }
        }}
        dangerouslySetInnerHTML={{ __html: initHtml }}
      />
      {trigger && visibleGroups.length > 0 ? (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-72 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          {/* 组内搜索（open-ai-canvas mention 菜单分区+搜索范式）：过滤标题
              与正文；↑↓/Enter 与编辑器内同一套导航 */}
          <input
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (handleNavKey(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (searchQ) {
                  setSearchQ("");
                  setHi(0);
                } else {
                  setTrigger(null);
                  edRef.current?.focus();
                }
              }
            }}
            placeholder="搜索卡片（标题/正文）…"
            className="mb-1 w-full rounded-md border border-hairline bg-surface-2/60 px-2 py-1 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
          />
          {visibleGroups.length > 1 ? (
            <div className="mb-1 flex gap-0.5 overflow-x-auto border-b border-hairline-soft pb-1">
              {visibleGroups.map((g, gi) => (
                <button
                  key={g.key}
                  type="button"
                  data-tip="左右方向键快速切换分组" aria-label={`分组 ${g.label}`}
                  className={`shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] transition-colors ${
                    gi === tab
                      ? "bg-accent-dim text-text"
                      : "text-text-3 hover:bg-surface-2 hover:text-text"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTabIdx(gi);
                    setHi(0);
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="max-h-44 overflow-y-auto">
            {curNodes.length === 0 ? (
              <p className="px-2 py-2 text-[10px] leading-relaxed text-text-4">
                没有匹配「{searchQ}」的卡
              </p>
            ) : (
              curNodes.map((c, i) => {
                const isConnected = connectedIds?.includes(c.id) ?? false;
                const active = i === hiClamped;
                return (
                <button
                  key={c.id}
                  ref={active ? hiRef : undefined}
                  type="button"
                  // 阻止 mousedown 抢焦点导致编辑器失焦闪烁
                  onMouseDown={(e) => e.preventDefault()}
                  className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs ${
                    active ? "bg-surface-2 text-text" : "text-text-2"
                  }`}
                  onClick={() => pick(c)}
                  onMouseEnter={() => setHi(i)}
                  title={c.id === nodeId ? "引用本卡当前图（图生图迭代）" : undefined}
                >
                  <RefBadge node={c} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {c.id === nodeId ? "本卡原图 · " : ""}
                      {c.data.title || NODE_META[c.data.nodeType]?.label || "（无标题）"}
                    </span>
                    {(c.data.body ?? "").trim() ? (
                      <span className="block truncate text-[9px] leading-tight text-text-4">
                        {(c.data.body as string).slice(0, 48)}
                      </span>
                    ) : null}
                  </span>
                  {isConnected ? (
                    <span className="ml-auto shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] text-accent">
                      已连线
                    </span>
                  ) : (
                    <span className="ml-auto shrink-0 text-[10px] text-text-4">
                      {NODE_META[c.data.nodeType]?.label}
                    </span>
                  )}
                </button>
                );
              })
            )}
          </div>
        </div>
      ) : trigger ? (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-lg border border-hairline bg-surface-1 p-2 text-[10px] leading-relaxed text-text-4 shadow-lg">
          {trigger.q
            ? `没有匹配「${trigger.q}」的卡——删掉关键词可看全部可引用卡`
            : "画布上还没有可引用的卡"}
        </div>
      ) : null}
    </div>
  );
});

/** 候选项缩略（有图用缩略图，无图降级类型首字徽标）——与 PromptBar.RefThumb 同款 */
function RefBadge({ node }: { node: WingNode }) {
  const url = node.data.imageUrl as string | undefined;
  const meta = NODE_META[node.data.nodeType];
  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={assetThumbUrl(url)}
        alt=""
        className="h-6 w-6 shrink-0 rounded-sm bg-surface-2 object-cover"
      />
    );
  return (
    <span
      className="grid h-6 w-6 shrink-0 place-items-center rounded-sm bg-surface-2 text-[10px] font-medium"
      style={{ color: meta?.dot }}
      title={meta?.label}
    >
      {meta?.label?.slice(0, 1) ?? "?"}
    </span>
  );
}

export default MentionInput;
