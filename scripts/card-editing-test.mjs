/**
 * E2E 回归：卡内文本编辑（剧本卡 Editable）。
 * 历史事故：受控 textarea 撞上 xyflow 内部节点副本晚一拍，每次击键 React
 * 先回写一次"旧值"——刚打的字被抹掉、光标甩到文末、中文 IME 组合被毁
 * （用户表现：只能输入英文 / 中途加字跑到全文最后）。现 Editable 为
 * 非受控（defaultValue + 未聚焦守卫回写），本脚本用 CDP 真实 IME 时序锁住：
 *  - 中途插入光标不跳、连续插入逐字落位
 *  - 打字期间 React 零次 .value 强写（根因断言）
 *  - IME 组合存活、上屏落在光标处
 *  - 失焦落库（store/服务端）、外部改值未聚焦回写
 * 前置：agent(8123) + 前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
function envLocal(key) {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
}
let TOKEN = "";
{
  const r = await fetch(`${BASE}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: envLocal("AUTH_USERNAME") || "admin",
      password: envLocal("AUTH_PASSWORD"),
    }),
  });
  if (r.ok) TOKEN = (await r.json()).access_token ?? "";
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- 测试项目 + 剧本卡 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-editing-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;

const BODY = [
  "1-65: 倀子领首者在火光中猛然仰头，面庞剧烈扭曲，双眼怒睁奋力呐喊。",
  "1-66: 倀子领首者在原地紧握火炬，右臂猛地后拉，快速前挥将火炬抛出。",
  "1-67: 燃烧的火炬在夜空中极速翻滚，火星猛烈飞溅，划出弧线。",
].join("\n");
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      {
        id: "e2e_edit_script",
        type: "script",
        position: { x: 0, y: 0 },
        data: { nodeType: "script", title: "故事大纲或分场剧本", body: BODY },
      },
    ],
    edges: [],
    viewport: { x: 40, y: 40, zoom: 1 },
  }),
});

// ---------- 浏览器 ----------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
await page.goto(`${BASE}/project/${pid}`);

const ta = page.locator("textarea").first();
try {
  await ta.waitFor({ state: "visible", timeout: 15000 });
} catch {
  throw new Error("剧本卡 textarea 未出现（页面未加载/卡型渲染异常）");
}

// 猴耳补丁：记录 React 对 .value 的每次强写（根因断言的探针）
await page.evaluate(() => {
  const el = document.querySelector("textarea");
  window.__valueWrites = [];
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  Object.defineProperty(el, "value", {
    get() { return desc.get.call(el); },
    set(v) {
      const cur = desc.get.call(el);
      if (String(v) !== cur)
        window.__valueWrites.push({
          at: performance.now().toFixed(1),
          focused: document.activeElement === el,
          writeLen: String(v).length,
          domLen: cur.length,
        });
      desc.set.call(el, v);
    },
  });
  window.__staleWritesWhileFocused = () =>
    window.__valueWrites.filter((w) => w.focused).length;
});

const caretIdx = BODY.indexOf("奋力呐喊") + 2; // 呐喊 之后、。 之前
const anchorSnapshot = () =>
  page.evaluate(
    (idx) => {
      const el = document.querySelector("textarea");
      return { sel: el.selectionStart, len: el.value.length, around: el.value.slice(Math.max(0, el.selectionStart - 6), el.selectionStart + 6) };
    },
    caretIdx,
  );

// ---------- A1: 中途插入，光标不跳 ----------
await ta.focus();
await page.evaluate((idx) => {
  const el = document.querySelector("textarea");
  el.setSelectionRange(idx, idx);
}, caretIdx);
await page.evaluate(() => document.execCommand("insertText", false, "Q"));
await page.waitForTimeout(400);
const a1 = await anchorSnapshot();
check(
  "A1 中途插入后光标停在插入处",
  a1.sel === caretIdx + 1 && a1.around.includes("Q"),
  `sel=${a1.sel}/${a1.len} 附近:「${a1.around}」`,
);

// ---------- A2: 连续插入逐字落位 ----------
await page.evaluate(async () => {
  const el = document.querySelector("textarea");
  for (const ch of "123456") {
    document.execCommand("insertText", false, ch);
    await new Promise((r) => setTimeout(r, 60));
  }
});
const a2 = await page.evaluate(
  (idx) => {
    const el = document.querySelector("textarea");
    return {
      inserted: el.value.slice(idx, idx + 7),
      sel: el.selectionStart,
    };
  },
  caretIdx,
);
check(
  "A2 连续中途插入逐字落位（不追加到文末）",
  a2.inserted === "Q123456" && a2.sel === caretIdx + 7,
  `插入段:「${a2.inserted}」 sel=${a2.sel}`,
);

// ---------- A3: 打字期间 React 零次 .value 强写（根因断言） ----------
const staleWrites = await page.evaluate(() => window.__staleWritesWhileFocused());
check("A3 打字期间无 React 旧值回写", staleWrites === 0, `聚焦中强写 ${staleWrites} 次`);

// ---------- A4/A5: IME 组合存活 + 上屏落位 ----------
// 注意：CDP imeSetComposition 的 selectionStart/End 是相对 replacementStart
// 的偏移（replacement 本身才是绝对区间），断言按此语义给参
const cdp = await context.newCDPSession(page);
const anchor66 = await page.evaluate(() => {
  const el = document.querySelector("textarea");
  const idx = el.value.indexOf("1-66:") + 12; // 第二行行内任意锚点
  el.focus();
  el.setSelectionRange(idx, idx);
  return idx;
});
await cdp.send("Input.imeSetComposition", {
  text: "hanhan",
  selectionStart: 6, // 相对锚点：组合串末尾
  selectionEnd: 6,
  replacementStart: anchor66,
  replacementEnd: anchor66,
});
await page.waitForTimeout(300);
const a4 = await anchorSnapshot();
check(
  "A4 IME 组合存活（拼音不被回写吞掉、光标不跳）",
  a4.around.includes("hanhan") && a4.sel === anchor66 + 6,
  `sel=${a4.sel}(期望 ${anchor66 + 6}) 附近:「${a4.around}」`,
);
await cdp.send("Input.imeSetComposition", {
  text: "呐喊",
  selectionStart: 2, // 相对锚点：上屏串末尾
  selectionEnd: 2,
  replacementStart: anchor66,
  replacementEnd: anchor66 + 6,
});
await page.waitForTimeout(300);
const a5 = await anchorSnapshot();
check(
  "A5 上屏落在光标处",
  a5.around.includes("呐喊") && a5.sel === anchor66 + 2,
  `sel=${a5.sel}(期望 ${anchor66 + 2}) 附近:「${a5.around}」`,
);

// ---------- A6: 失焦落库 ----------
await page.evaluate(() => document.querySelector("textarea").blur());
await page.waitForTimeout(1800); // ProjectManager 1.2s debounce 同步
const { body: canvasAfter } = await api(`/projects/${pid}/canvas`);
const savedNode = (canvasAfter?.nodes ?? []).find((n) => n.id === "e2e_edit_script");
const savedBody = String(savedNode?.data?.body ?? "");
check(
  "A6 失焦后正文落库",
  savedBody.includes("Q123456") && savedBody.includes("呐喊"),
  savedBody.includes("Q123456") ? "已包含中途插入与上屏文本" : `实际:「${savedBody.slice(0, 60)}…」`,
);

// ---------- A7: 外部改值走 store 回写 DOM（守卫 effect） ----------
// 外部改值的真实入口是 store 更新（AI 撰写覆盖/版本恢复/撤销/agent 改卡），
// 都先经一次点击失焦再改 store。契约：聚焦中不打断用户（用户胜出），
// 失焦后 store 是事实源、回写 DOM
const externalBody = `${savedBody}\n1-99: 外部写入的测试行。`;
const a7 = await page.evaluate(async (next) => {
  const store = window.__wsCanvasStore;
  if (!store) return { noHook: true };
  const el = document.querySelector("textarea");
  const userText = el.value;
  el.focus(); // 1) 聚焦中外部改值：用户文本不被清掉
  store.getState().updateNodeData("e2e_edit_script", { body: next });
  await new Promise((r) => setTimeout(r, 150));
  const focusedKept = !el.value.includes("外部写入");
  el.blur(); // 2) 失焦 commit：聚焦期间的用户文本落库（最后写者胜出）
  await new Promise((r) => setTimeout(r, 300));
  const storedAfterBlur = String(
    store
      .getState()
      .nodes.find((n) => n.id === "e2e_edit_script")?.data.body ?? "",
  );
  const userWinsOnBlur = storedAfterBlur === userText;
  // 3) 未聚焦时外部改值：回写 DOM（AI 覆盖/版本恢复通道）
  const external2 = `${userText}\n1-98: 第二次外部写入。`;
  store.getState().updateNodeData("e2e_edit_script", { body: external2 });
  await new Promise((r) => setTimeout(r, 300));
  const syncedAfterBlur = el.value.includes("1-98: 第二次外部写入。");
  return { focusedKept, userWinsOnBlur, syncedAfterBlur };
}, externalBody);
check(
  "A7 外部改值：聚焦不打断用户、失焦回写 DOM",
  a7.focusedKept && a7.userWinsOnBlur && a7.syncedAfterBlur,
  `聚焦保持=${a7.focusedKept} 用户落库=${a7.userWinsOnBlur} 失焦回写=${a7.syncedAfterBlur}`,
);

// ---------- 汇总 ----------
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await api(`/projects/${pid}`, { method: "DELETE" });
if (failed.length > 0) process.exit(1);
