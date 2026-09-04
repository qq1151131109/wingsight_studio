/**
 * E2E：会话智能命名（API 闭环，无浏览器；真跑 LLM 一次约 10-30s）。
 * 建项目 + 会话 → 存首组对话（user+assistant）→ 轮询标题从「首条消息截断」
 * 升级为 LLM 生成的短标题；再验证用户手动命名后不被覆盖。
 */
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

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
    body: new URLSearchParams({ username: envLocal("AUTH_USERNAME") || "admin", password: envLocal("AUTH_PASSWORD") }),
  });
  if (r.ok) TOKEN = (await r.json()).access_token ?? "";
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const pr = await (await fetch(`${API}/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: `e2e-autotitle-${Date.now()}` }) })).json();
const pid = pr.id ?? pr.project?.id;
const th = await (await fetch(`${API}/projects/${pid}/threads`, { method: "POST", headers: auth, body: JSON.stringify({ title: "" }) })).json();
const tid = th.id;

const USER_MSG = "帮我把画布上的剧本拆成 20 镜的标准分镜表，要带景别和运镜";
const AI_MSG = "好的，已按剧本结构生成 8 镜分镜表并写回分镜表卡，每镜含景别、运镜、时长与旁白。";

// ① 只有 user 消息的首次保存：过渡标题 = 首条消息截断
await fetch(`${API}/projects/${pid}/threads/${tid}/messages`, {
  method: "PUT",
  headers: auth,
  body: JSON.stringify({ messages: [{ id: "m1", role: "user", content: USER_MSG }] }),
});
const t1 = (await (await fetch(`${API}/projects/${pid}/threads`, { headers: auth })).json()).find((t) => t.id === tid);
check("过渡标题=首条消息截断", typeof t1?.title === "string" && USER_MSG.startsWith(t1.title) && t1.title.length > 0, t1?.title);

// ② 补上 assistant 消息（首组对话完成）→ LLM 智能命名
await fetch(`${API}/projects/${pid}/threads/${tid}/messages`, {
  method: "PUT",
  headers: auth,
  body: JSON.stringify({
    messages: [
      { id: "m1", role: "user", content: USER_MSG },
      { id: "m2", role: "assistant", content: AI_MSG },
    ],
  }),
});
let titled = "";
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const t = (await (await fetch(`${API}/projects/${pid}/threads`, { headers: auth })).json()).find((x) => x.id === tid);
  if (t?.title && !USER_MSG.startsWith(t.title)) {
    titled = t.title;
    break;
  }
}
check("LLM 智能命名落地", titled.length > 0, titled);
check("标题简短（≤16字）", titled.length <= 16, `${titled.length} 字`);

// ③ 再保存不覆盖；用户手动命名后也不再覆盖
await fetch(`${API}/projects/${pid}/threads/${tid}/messages`, {
  method: "PUT",
  headers: auth,
  body: JSON.stringify({
    messages: [
      { id: "m1", role: "user", content: USER_MSG },
      { id: "m2", role: "assistant", content: AI_MSG },
      { id: "m3", role: "user", content: "谢谢，再压到 12 镜" },
    ],
  }),
});
await fetch(`${API}/projects/${pid}/threads/${tid}`, { method: "PATCH", headers: auth, body: JSON.stringify({ title: "我的分镜工作" }) });
await new Promise((r) => setTimeout(r, 4000));
const t3 = (await (await fetch(`${API}/projects/${pid}/threads`, { headers: auth })).json()).find((x) => x.id === tid);
check("用户命名不被覆盖", t3?.title === "我的分镜工作", t3?.title);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项失败`}（${results.length} 项）`);
process.exit(failed.length === 0 ? 0 : 1);
