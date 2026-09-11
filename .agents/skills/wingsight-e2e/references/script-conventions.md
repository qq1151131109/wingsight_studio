# 回归脚本骨架约定

从 `scripts/chat-spacing-test.mjs`、`scripts/cleanup-test-projects.mjs` 提炼。写新脚本前先读两个现成的同类脚本对齐，不要自创风格。

## 头部注释

每份脚本开头一段块注释，写清楚四件事：

1. 这条回归守的是什么，以及**当初踩过的坑**（带日期与现象，例如"连发两条用户消息 0px 贴死"）。
2. 逐条编号的断言清单（① ② ③ …），后面 `check()` 的文案与之一一对应。
3. 自建临时项目并自删。
4. `用法：node scripts/xxx-test.mjs （需 web:8008 + agent:8123 在跑）`。

断言文案带编号，失败时能直接对回注释里的第几条。

## 骨架

```js
import fs from "node:fs";
import { chromium } from "playwright";

// WS_BASE 可指别的实例（如本地 dev:8009），默认生产口 8008
const WEB = process.env.WS_BASE || "http://127.0.0.1:8008";
const AGENT = "http://127.0.0.1:8123";

// auth 关闭时（本机常态）按匿名跑——不带头，端点也放行
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();
let TOKEN = "";
if (AUTH_PASSWORD) {
  const login = await fetch(`${AGENT}/api/v1/auth/token`, {
    method: "POST",
    body: new URLSearchParams({ username: "admin", password: AUTH_PASSWORD }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}`);
  TOKEN = (await login.json()).access_token;
}

const api = async (path, init) => {
  const r = await fetch(`${AGENT}${path}`, {
    ...init,
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

// 自建临时项目：名字前缀 e2e- / verify- 是 cleanup-test-projects.mjs 的回收依据
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-xxx-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建临时项目失败 ${pst}`);
const PID = proj.id ?? proj.project?.id;
const dropProject = () => api(`/projects/${PID}`, { method: "DELETE" }).catch(() => {});
const bail = async (e) => { console.error(e); await dropProject(); process.exit(1); };
process.on("uncaughtException", (e) => void bail(e));
process.on("unhandledRejection", (e) => void bail(e));

const results = [];
const check = (name, ok, detail = "") => {
  results.push([Boolean(ok), name, detail]);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
```

结尾固定两段：截图/关闭浏览器 → `await dropProject()` → 按 `results` 判定退出码。

```js
await browser.close();
await dropProject();

const failed = results.filter(([ok]) => !ok);
if (failed.length) {
  console.error(`\n✗✗ <回归名> ${failed.length}/${results.length} 未过`);
  process.exit(1);
}
console.log(`\n✓✓ <回归名>全过（${results.length} 项，临时项目已删）`);
```

`bail` 只挡未捕获异常；**断言失败走不到 `dropProject` 的场景也要自己补 teardown**，否则残留靠 `cleanup-test-projects.mjs` 收。

## 备选接法

- 经前端代理而不是直连 agent 时用 `${WEB}/agent-service/...`；`cleanup-test-projects.mjs` 就是这个路子。
- 纯函数回归（无服务、无浏览器）不需要临时项目与 bail，直接 import 被测模块 + `check()` 即可，参考 `ref-group-collapse-test.mjs`。

## 造竞态与 mock

- 要在真实 UI 上压竞态（上传中回车、跨卸载续链）时，用 Playwright `page.route` 延迟或拦截特定请求制造窗口，别去改产品代码加等待。范例：`attach-race-test.mjs`、`ref-batch-unmount-resume-test.mjs`。
- mock SSE / mock 出图时按 `route.fulfill` 返回既有事件形状，不要另发明一套；真链路语义另有真跑 LLM 的回归覆盖（如 `chat-longcontent-test.mjs` 的 E 组）。

## 禁区

- 不要用 `git checkout` / 直接改 SQLite 来"重置"状态，测试残留走 `cleanup-test-projects.mjs` + `prune-checkpoints.py`。
- 不要依赖只在 dev 模式存在的调试钩子，除非脚本明确标注「需 dev 模式」。
- 不要把断言写成比对文案/标题的字符串匹配；断言可观察行为或数据契约。
