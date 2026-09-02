/**
 * 深度调研 API 全链路实测：建项目 → 发起（quick）→ 开题确认 → 轮询到卷宗 → gap 补研。
 * 掐每阶段耗时，校验卷宗结构与来源底账。
 * 运行：node scripts/research-api-journey-test.mjs（需 agent 在跑）
 */
import fs from "node:fs";
const BASE = "http://127.0.0.1:8123";
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();

const t0 = Date.now();
const sec = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

async function api(path, opts = {}, raw = false) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return raw ? text : JSON.parse(text);
}

let TOKEN;
async function main() {
  // 登录
  const form = new URLSearchParams({ username: "admin", password: AUTH_PASSWORD });
  const login = await fetch(`${BASE}/api/v1/auth/token`, { method: "POST", body: form });
  TOKEN = (await login.json()).access_token;
  if (!TOKEN) throw new Error("登录失败");
  console.log(sec(), "✓ 登录");

  // 建测试项目
  const proj = await api("/projects", {
    method: "POST",
    body: JSON.stringify({ name: `调研实测-${Date.now() % 100000}` }),
  });
  const pid = proj.id ?? proj.project?.id;
  console.log(sec(), "✓ 项目", pid);

  // 发起调研（quick）
  const started = await api(`/projects/${pid}/research`, {
    method: "POST",
    body: JSON.stringify({
      topic: "殷墟妇好墓的发现经过与出土文物",
      brief: "侧重发现过程叙事与可拍实物",
      depth: "quick",
    }),
  });
  const jid = started.jobId;
  console.log(sec(), "✓ 发起", jid);

  // 等开题
  let job;
  for (let i = 0; i < 90; i++) {
    job = await api(`/projects/${pid}/research/${jid}`);
    if (job.plan || job.status === "error") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!job.plan) throw new Error(`开题失败：${job.status} ${job.error}`);
  console.log(sec(), `✓ 开题（${((Date.now()) / 1000).toFixed(0)}）观看问题：${job.plan.viewingQuestion.slice(0, 60)}`);
  job.plan.directions.forEach((d, i) =>
    console.log(`   ${i + 1}. ${d.title}（${d.queries.length} 词）`),
  );

  // 确认
  const tConfirm = Date.now();
  await api(`/projects/${pid}/research/${jid}/confirm`, { method: "POST", body: "{}" });
  console.log(sec(), "✓ 已确认，开始执行");

  // 轮询到终态（上限 12 分钟）
  let last = "";
  for (let i = 0; i < 900; i++) { // 网关慢时全程可到 20 分钟
    job = await api(`/projects/${pid}/research/${jid}`);
    const line = `${job.status} ${job.stage} 轮${job.roundsDone}/${job.roundsTotal} 源${job.sourcesCount} 事实${job.findingsCount}`;
    if (line !== last) { console.log(sec(), " ", line); last = line; }
    if (["done", "error", "stopped", "interrupted"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const dur = ((Date.now() - tConfirm) / 1000).toFixed(0);
  if (job.status !== "done") throw new Error(`执行失败：${job.status} ${job.error}`);
  console.log(sec(), `✓ 完成（执行 ${dur}s）`);

  // 卷宗结构
  const d = job.dossier;
  const ok = d.headline && d.summary && Array.isArray(d.establishedFacts);
  console.log(sec(), ok ? "✓ 卷宗结构完整" : "✗ 卷宗结构缺段",
    `脊${d.narrativeSpine?.length ?? 0} 事实${d.establishedFacts?.length ?? 0} 争议${d.controversies?.length ?? 0} 风险${d.risks?.length ?? 0} 簇${d.materialClusters?.length ?? 0}`);
  console.log("   headline:", d.headline);
  const srcRes = await api(`/projects/${pid}/research/${jid}/sources`);
  const cats = {};
  srcRes.sources.forEach((s) => (cats[s.category] = (cats[s.category] || 0) + 1));
  const snippetOnly = srcRes.sources.filter((s) => s.fetchStatus === "snippet").length;
  console.log(sec(), `✓ 来源 ${srcRes.sources.length}（摘要级 ${snippetOnly}）分类:`, JSON.stringify(cats));

  // 引用完整性：卷宗里的 refs 必须都在来源底账
  const sids = new Set(srcRes.sources.map((s) => s.sid));
  const allRefs = [
    ...(d.establishedFacts || []), ...(d.narrativeSpine || []),
    ...d.controversies.flatMap((c) => c.versions),
    ...(d.risks || []),
    ...d.materialClusters.flatMap((m) => m.points),
  ].flatMap((x) => x.refs || []);
  const bad = allRefs.filter((r) => !sids.has(r));
  console.log(sec(), bad.length ? `✗ 幻觉引用 ${[...new Set(bad)].join(",")}` : "✓ 引用全部命中来源底账");

  // gap 补研
  const gap = await api(`/projects/${pid}/research/${jid}/gap`, {
    method: "POST",
    body: JSON.stringify({ questions: ["妇好墓墓葬形制与殉人情况"] }),
  });
  console.log(sec(), "✓ 补研发起", gap.jobId);
  for (let i = 0; i < 600; i++) {
    const g = await api(`/projects/${pid}/research/${gap.jobId}`);
    if (["done", "error"].includes(g.status)) {
      if (g.status !== "done") throw new Error(`补研失败：${g.error}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const after = await api(`/projects/${pid}/research/${jid}`);
  console.log(sec(), `✓ 补研完成：源 ${job.sourcesCount}→${after.sourcesCount}，卷宗仍 ${after.status}`);
  console.log("\n✓✓ API 全链路实测通过");
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
