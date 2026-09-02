/**
 * E2E 回归：剧本审查管线（合规/一致性/事实核查三维度）。
 *  - 三维度真跑 LLM flow（需 agent(8123)+langflow(7860)+Serper 号池在跑）
 *  - job 生命周期：queued/running → done；dims 逐维度状态
 *  - findings 结构：dimension/severity 枚举、quote 锚点区间与正文对得上
 *  - 合规必中（广告法极限词台词）、事实必中（可证伪断言）；一致性只验结构不验命中（LLM 判定有随机性）
 *  - dismiss 往返 / latest 摘要 / 取消语义 / 参数校验 400
 * 前置：agent(8123)+langflow(7860) 在跑；自建测试项目，不出真实画布数据。
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const BASE = "http://127.0.0.1:8123";

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
  const r = await fetch(`${BASE}${path}`, {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 剧本：合规（广告法极限词台词）/ 一致性（人名前后不一致）/ 事实（可证伪断言）都能命中
const SCRIPT = `第1场 夜，老药铺内堂。

王掌柜举起瓷瓶，冲满堂客人喊：「这是祖传国家级秘方，包治百病！喝一口百病全消！」
人群里传来惊叹。林晚挤到最前面，眼睛发亮。

第2场 日，集市。

林晚在人头攒动的集市里打听瓷瓶的来历。路人低声说：「这药曾进贡朝廷，当年李白喝过一壶，还题了词。」
林晚握紧了钱袋：「诗仙李白是南宋有名的词人，他的题词一定值钱。」`;

const NODE_ID = "e2e-script-node-1";

// ---------- 测试项目 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-script-review-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
check("建测试项目", true, pid);

// ---------- 参数校验 ----------
{
  const empty = await api(`/projects/${pid}/script-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: NODE_ID, title: "t", body: "  ", dimensions: ["compliance"] }),
  });
  check("空正文 400", empty.status === 400, String(empty.body).slice(0, 60));
  const baddim = await api(`/projects/${pid}/script-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: NODE_ID, title: "t", body: "有内容", dimensions: ["nope"] }),
  });
  check("非法维度 400", baddim.status === 400, String(baddim.body).slice(0, 60));
  const badmodel = await api(`/projects/${pid}/script-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: NODE_ID, title: "t", body: "有内容", dimensions: ["compliance"], textModel: "gpt-x" }),
  });
  check("非法模型 400", badmodel.status === 400, String(badmodel.body).slice(0, 60));
  const nojob = await api(`/projects/${pid}/script-review?nodeId=${NODE_ID}`);
  check("无审查记录 404", nojob.status === 404);
}

// ---------- 发起三维度审查 ----------
const started = await api(`/projects/${pid}/script-review`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodeId: NODE_ID,
    title: "e2e 剧本",
    body: SCRIPT,
    dimensions: ["compliance", "consistency", "fact"],
  }),
});
check("发起审查", started.status === 200, started.status === 200 ? `job=${started.body.jobId}` : JSON.stringify(started.body).slice(0, 120));
const jobId = started.body?.jobId;
if (!jobId) throw new Error("未拿到 jobId，终止");
check("初始态 queued/running", ["queued", "running"].includes(started.body.status), started.body.status);

// ---------- 轮询到终态 ----------
let job = started.body;
const t0 = Date.now();
while ((job.status === "queued" || job.status === "running") && Date.now() - t0 < 420_000) {
  await sleep(4000);
  const r = await api(`/projects/${pid}/script-review/${jobId}`);
  if (r.status === 200) job = r.body;
  else console.log(`  轮询 ${r.status}: ${String(r.body).slice(0, 80)}`);
}
check("终态 done", job.status === "done", `status=${job.status} error=${(job.body?.error || job.error || "").slice(0, 120)} 耗时=${Math.round((Date.now() - t0) / 1000)}s`);
check("三维度全部 done", ["compliance", "consistency", "fact"].every((d) => job.dims?.[d]?.state === "done"),
  JSON.stringify(job.dims));

const findings = job.findings ?? [];
check("findings 非空", findings.length > 0, `${findings.length} 条`);
check("severity 枚举合法", findings.every((f) => ["high", "medium", "low"].includes(f.severity)));
check("dimension 枚举合法", findings.every((f) => ["compliance", "consistency", "fact"].includes(f.dimension)));
check("message 非空", findings.every((f) => f.message && f.quote));

// 锚点：服务端区间必须与正文对上（至少一条命中；未命中应为 -1）
const anchored = findings.filter((f) => f.quoteStart >= 0);
check("存在正确定位锚", anchored.length > 0, `${anchored.length}/${findings.length} 条带锚`);
check("锚区间与正文一致", anchored.every((f) => {
  const seg = SCRIPT.slice(f.quoteStart, f.quoteEnd);
  return seg.replace(/\s+/g, "") === f.quote.replace(/\s+/g, "");
}));

// 合规必中：广告法极限词台词
const comp = findings.filter((f) => f.dimension === "compliance");
check("合规命中（广告法极限词）", comp.length > 0, comp.map((f) => f.category).join("/"));

// 事实必中：可证伪断言（李白是南宋词人）
const fact = findings.filter((f) => f.dimension === "fact");
check("事实核查命中（可证伪断言）", fact.length > 0, fact.map((f) => f.category).join("/"));
check("事实 finding 带来源", fact.every((f) => Array.isArray(f.evidence)), `${fact[0]?.evidence?.length ?? 0} 源`);

// 一致性：不 assert 命中数（LLM 判定有随机性），命中则验结构
const cons = findings.filter((f) => f.dimension === "consistency");
check("一致性结构合法", cons.every((f) => f.message && f.category), cons.length ? `${cons.length} 条` : "0 条（不判失败）");

// ---------- latest 摘要 ----------
{
  const s = await api(`/projects/${pid}/script-review?nodeId=${NODE_ID}`);
  check("latest 摘要", s.status === 200 && s.body.jobId === jobId && s.body.totalCount === findings.length,
    `total=${s.body?.totalCount} open=${s.body?.openCount}`);
}

// ---------- dismiss 往返 ----------
if (findings.length > 0) {
  const f0 = findings[0];
  const d1 = await api(`/projects/${pid}/script-review/${jobId}/findings/${f0.id}/dismiss`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dismissed: true }),
  });
  check("dismiss 置位", d1.status === 200 && d1.body.dismissed === true);
  const s1 = await api(`/projects/${pid}/script-review?nodeId=${NODE_ID}`);
  check("openCount 减一", s1.body.openCount === findings.length - 1, `open=${s1.body.openCount}`);
  const d2 = await api(`/projects/${pid}/script-review/${jobId}/findings/${f0.id}/dismiss`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dismissed: false }),
  });
  check("dismiss 复位", d2.status === 200 && d2.body.dismissed === false);
  const dBad = await api(`/projects/${pid}/script-review/${jobId}/findings/nope/dismiss`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dismissed: true }),
  });
  check("未知 finding 404", dBad.status === 404);
}

// ---------- 指纹对原文（P1 回归：尾换行剧本不得 strip 后算 sha1，否则前端必亮假「已修改」横幅） ----------
{
  const raw = `${SCRIPT}\n\n  `; // 尾换行+空白（Editable 存 textarea 原文的常态）
  const s = await api(`/projects/${pid}/script-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeId: `${NODE_ID}-fp`, title: "指纹用例", body: raw, dimensions: ["compliance"],
    }),
  });
  const fjid = s.body?.jobId;
  check("指纹用例发起", s.status === 200 && !!fjid);
  const g = await api(`/projects/${pid}/script-review/${fjid}`);
  const want = createHash("sha1").update(raw, "utf8").digest("hex");
  check("sha1 按原文（含尾空白）", g.body?.bodySha1 === want, `got=${g.body?.bodySha1?.slice(0, 8)} want=${want.slice(0, 8)}`);
  check("bodyChars 按原文", g.body?.bodyChars === raw.length, `got=${g.body?.bodyChars} want=${raw.length}`);
  await api(`/projects/${pid}/script-review/${fjid}/cancel`, { method: "POST" });
}

// ---------- 取消语义（单维度合规，起跑即取消，1s 粒度打断在途 flow） ----------
{
  const c = await api(`/projects/${pid}/script-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeId: `${NODE_ID}-cancel`,
      title: "cancel 用例",
      body: SCRIPT,
      dimensions: ["compliance"],
    }),
  });
  const cjid = c.body?.jobId;
  check("取消用例发起", c.status === 200 && !!cjid);
  const r = await api(`/projects/${pid}/script-review/${cjid}/cancel`, { method: "POST" });
  check("cancel 返回 ok", r.status === 200 && r.body.ok === true, `${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
  // 取消应在数秒内打断在途 flow（不等 240s flow 跑完）
  let after = null;
  const c0 = Date.now();
  while (Date.now() - c0 < 30_000) {
    await sleep(1500);
    const g = await api(`/projects/${pid}/script-review/${cjid}`);
    after = g.body;
    if (after?.status === "stopped") break;
  }
  check("取消后 stopped", after?.status === "stopped", `status=${after?.status} 耗时=${Math.round((Date.now() - c0) / 1000)}s`);
  const again = await api(`/projects/${pid}/script-review/${cjid}/cancel`, { method: "POST" });
  check("终态再取消 409", again.status === 409, `${again.status} ${String(again.body).slice(0, 60)}`);
}

// ---------- 重复任务防重入 ----------
{
  const dup = await api(`/projects/${pid}/script-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeId: `${NODE_ID}-cancel`, title: "dup", body: SCRIPT, dimensions: ["compliance"],
    }),
  });
  // cancel 用例已终态，这里应能正常发起；立刻再发一次应被拒
  if (dup.status === 200) {
    const dup2 = await api(`/projects/${pid}/script-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: `${NODE_ID}-cancel`, title: "dup", body: SCRIPT, dimensions: ["compliance"],
      }),
    });
    check("同卡在跑防重入 400", dup2.status === 400, String(dup2.body).slice(0, 60));
    await api(`/projects/${pid}/script-review/${dup.body.jobId}/cancel`, { method: "POST" });
  } else {
    check("同卡在跑防重入 400", dup.status === 400, String(dup.body).slice(0, 60));
  }
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : "存在失败"}：${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
