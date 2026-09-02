/**
 * E2E 回归：智能编排（出图指令合成，novanova KEEP/OPTIMIZE 范式）。
 *  - OPTIMIZE：短指令 + 长设定 → 合成提示词为完整画面描述、融入设定内容
 *  - KEEP：改图指令（对参考图的修改意图）→ 原样逐字直传
 * 真实调用「指令合成」flow（一次文本 LLM）+ 真实出图两张（消耗额度）。
 * 前置：agent(8123，含 LANGFLOW_COMPOSE_FLOW_ID) + langflow(7860) 在跑。
 */
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8008";
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
async function api(path, init) {
  const r = await fetch(`${BASE}/agent-service${path}`, {
    ...init,
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const SETTING =
  "现代都市年轻女性，独自在出租屋看电视、反思卓文君故事的旁观者，亦是独立清醒的现代女性代表，最终走进书店、收拾行李走向阳光。二十多岁，神情由啼嬉转为自信坚定。视觉：冷白灯光与霓虹夜景交织的出租屋，快节奏都市剪辑；后期书店自然暖光与逆光背影，色调由冷转暖。";

const startJob = async (shots) => {
  const start = await api("/storyboard/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shots,
      params: { model: "gpt-image-2-03", resolution: "1K" },
    }),
  });
  if (start.status !== 200) throw new Error(`启动任务失败 ${start.status}: ${JSON.stringify(start.body).slice(0, 160)}`);
  return start.body.jobId;
};
const poll = async (jobId) => {
  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await api(`/storyboard/images/${jobId}`);
    if (r.body?.status === "done") return r.body;
    if (r.body?.status === "cancelled") throw new Error("已取消");
    if (Date.now() > deadline) throw new Error("轮询超时");
  }
};

// ---------- 用例 1：OPTIMIZE（短指令 + 长设定） ----------
{
  const jobId = await startJob([
    {
      rid: "opt1",
      name: "现代女孩",
      description: "现代女孩",
      assetType: "character",
      compose: true,
      instruction: "现代女孩",
      setting: SETTING,
      visualNotes: "全局视觉风格：电影感胶片质感",
    },
  ]);
  const done = await poll(jobId);
  const item = done.images?.find((i) => i.rid === "opt1");
  const cp = item?.composedPrompt ?? "";
  check("OPTIMIZE：合成结果存在且为 optimize", item?.composeAction === "optimize" && cp.length > 30,
    `action=${item?.composeAction} len=${cp.length}`);
  check(
    "OPTIMIZE：融入设定内容（书店/霓虹/出租屋 至少其二）",
    ["书店", "霓虹", "出租屋", "都市"].filter((k) => cp.includes(k)).length >= 2,
    cp.slice(0, 80),
  );
  check("出图成功", item?.ok === true && !!item?.imageUrl);
}

// ---------- 用例 2：KEEP（改图指令原样直传） ----------
{
  const INSTR = "把外套换成红色卫衣，其他保持不变，图1 的脸部不变";
  const jobId = await startJob([
    {
      rid: "keep1",
      name: "现代女孩",
      description: INSTR,
      assetType: "character",
      compose: true,
      instruction: INSTR,
      setting: SETTING,
      referenceLabels: [{ type: "image", name: "本卡原图" }],
      visualNotes: "全局视觉风格：电影感胶片质感",
    },
  ]);
  const done = await poll(jobId);
  const item = done.images?.find((i) => i.rid === "keep1");
  const cp = item?.composedPrompt ?? "";
  check("KEEP：改图指令原样逐字直传", item?.composeAction === "keep" && cp === INSTR,
    `action=${item?.composeAction} same=${cp === INSTR}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
