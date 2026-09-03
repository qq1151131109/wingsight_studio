/**
 * E2E：文本类卡导出回归（txt / md / docx）。
 * A 文本卡：底栏导出菜单 → txt/md 正文原样；docx 标题+正文可解包；
 * B 剧本卡：footer 导出菜单 → md/docx（docx 含正文分段）；
 * C 分镜表卡：底栏导出菜单 → md/txt 每镜一节（字段+视觉风格）；
 *   docx 横版表格（landscape/9 列表头/跨页重复/行内容）；
 * D 空卡导出按钮禁用（文本卡无正文不可导出）。
 * docx 验证 = unzip 解包 word/document.xml 断言内容与版式标记。
 * 前置：agent(8123) + 前端(8008) 在跑；系统有 unzip。
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
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

const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-card-export-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

// ---------- 画布预置：文本卡 / 剧本卡 / 分镜表卡 + 一张空文本卡 ----------
const NOTE_BODY = "窗外雨声不停。\n第二行笔记内容。";
const SCRIPT_BODY = "雨夜茶馆，侦探老陈对着名单抽烟。\n他合上卷宗起身。";
const ROWS = [
  {
    rid: "r1",
    shotSize: "特写",
    cameraMove: "推",
    duration: "3s",
    action: "老陈抬头看向门口",
    dialogue: "谁在敲门？",
    lighting: "台灯暖光，侧逆光",
    sound: "雨声，木门吱呀",
    finalPrompt: "老陈特写，烟气缭绕，雨夜暖光",
  },
  { rid: "r2", action: "少女推门而入，抖伞" },
];
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    viewport: { x: 0, y: 0, zoom: 0.6 },
    nodes: [
      {
        id: "n_export_note",
        type: "note",
        position: { x: 0, y: 0 },
        data: { nodeType: "note", title: "雨夜笔记", body: NOTE_BODY },
      },
      {
        id: "n_export_script",
        type: "script",
        position: { x: 420, y: 0 },
        data: { nodeType: "script", title: "测试剧本", body: SCRIPT_BODY },
      },
      {
        id: "n_export_shotlist",
        type: "shotlist",
        position: { x: 840, y: 0 },
        data: {
          nodeType: "shotlist",
          title: "雨夜分镜表",
          visualStyle: "赛博朋克雨夜",
          rows: ROWS,
          status: "ready",
        },
      },
      {
        id: "n_export_empty",
        type: "note",
        position: { x: 0, y: 320 },
        data: { nodeType: "note", title: "空笔记", body: "" },
      },
    ],
    edges: [],
  }),
});

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  acceptDownloads: true,
});
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(1500);

const tmp = mkdtempSync(join(tmpdir(), "wsexport-"));
const card = (title) => page.locator(".react-flow__node", { hasText: title });
const exportItem = async (cardTitle, itemLabel) => {
  const c = card(cardTitle);
  // 导出钮已上浮悬浮工具条（选中才渲染）：选中目标卡并把视口居中到它
  // （onlyRenderVisibleElements 会卸载视口外卡片，必须先入屏）
  await page.evaluate((t) => {
    const st = window.__wsCanvasStore.getState();
    const n = st.nodes.find((x) => (x.data.title || "") === t);
    if (!n) return;
    st.selectNodes([n.id]);
    const w = n.measured?.width ?? 288;
    const h = n.measured?.height ?? 320;
    const zoom = Math.min(1, Math.max(0.4, Math.min((1400 * 0.7) / w, (900 * 0.7) / h)));
    st.setViewport({
      x: 700 - (n.position.x + w / 2) * zoom,
      y: 450 - (n.position.y + h / 2) * zoom,
      zoom,
    });
  }, cardTitle);
  await page.waitForTimeout(500);
  // 文本卡导出在卡内底栏（节点子树内）；剧本/分镜表的导出在悬浮工具条
  // （react-flow__node-toolbar，节点子树外）——两处可见时不能点错卡
  const inCard = c.getByRole("button", { name: "导出文件" });
  if (await inCard.count()) {
    await inCard.first().click();
  } else {
    await page
      .locator('.react-flow__node-toolbar [aria-label="导出文件"]:visible')
      .first()
      .click();
  }
  const dlPromise = page.waitForEvent("download");
  dlPromise.catch(() => undefined); // 菜单项点击失败时不让悬挂的 waitForEvent 崩掉进程
  try {
    // 菜单 portal 到 body（不在节点子树里），菜单项只能按 page 级定位
    await page.getByRole("button", { name: itemLabel }).click({ timeout: 8000 });
  } catch (e) {
    await page.screenshot({ path: `scripts/_tmp-export-fail-${itemLabel}.png` });
    console.log(`[diag] ${cardTitle} ${itemLabel} click fail:`, String(e).split("\n").slice(0, 6).join("\n"));
    throw e;
  }
  const dl = await dlPromise;
  const path = join(tmp, dl.suggestedFilename());
  await dl.saveAs(path);
  return { path, filename: dl.suggestedFilename(), text: () => readFileSync(path, "utf8") };
};
const docxXml = (path, member = "word/document.xml") =>
  execSync(`unzip -p '${path}' '${member}'`, { encoding: "utf8" });

// ---------- A 文本卡 ----------
try {
  const txt = await exportItem("雨夜笔记", "纯文本");
  check(
    "A1 文本卡 txt 文件名与正文原样",
    txt.filename === "雨夜笔记.txt" && txt.text() === NOTE_BODY,
    `${txt.filename}`,
  );
} catch (e) {
  check("A1 文本卡 txt 文件名与正文原样", false, String(e).slice(0, 120));
}
try {
  const md = await exportItem("雨夜笔记", "Markdown");
  check("A2 文本卡 md 正文原样", md.filename === "雨夜笔记.md" && md.text() === NOTE_BODY);
} catch (e) {
  check("A2 文本卡 md 正文原样", false, String(e).slice(0, 120));
}
try {
  const docx = await exportItem("雨夜笔记", "Word 文档");
  const xml = docxXml(docx.path);
  check(
    "A3 文本卡 docx 含标题与正文两行",
    docx.filename === "雨夜笔记.docx" &&
      xml.includes("雨夜笔记") &&
      xml.includes("窗外雨声不停。") &&
      xml.includes("第二行笔记内容。"),
  );
} catch (e) {
  check("A3 文本卡 docx 含标题与正文两行", false, String(e).slice(0, 120));
}

// ---------- B 剧本卡 ----------
try {
  const md = await exportItem("测试剧本", "Markdown");
  check("B1 剧本卡 md 正文原样", md.filename === "测试剧本.md" && md.text() === SCRIPT_BODY);
} catch (e) {
  check("B1 剧本卡 md 正文原样", false, String(e).slice(0, 120));
}
try {
  const docx = await exportItem("测试剧本", "Word 文档");
  const xml = docxXml(docx.path);
  check(
    "B2 剧本卡 docx 含正文分段",
    xml.includes("雨夜茶馆，侦探老陈对着名单抽烟。") &&
      xml.includes("他合上卷宗起身。"),
  );
} catch (e) {
  check("B2 剧本卡 docx 含正文分段", false, String(e).slice(0, 120));
}

// ---------- C 分镜表卡 ----------
try {
  const md = await exportItem("雨夜分镜表", "Markdown");
  const t = md.text();
  check(
    "C1 分镜表 md 每镜一节（风格/字段/镜2仅画面）",
    md.filename === "雨夜分镜表.md" &&
      t.includes("# 雨夜分镜表") &&
      t.includes("> 共 2 镜 · 总时长约 3s") &&
      t.includes("> 视觉风格：赛博朋克雨夜") &&
      t.includes("## 镜1 · 特写 · 推 · 3s") &&
      t.includes("- 画面：老陈抬头看向门口") &&
      t.includes("- 台词/旁白：谁在敲门？") &&
      t.includes("- 光影：台灯暖光，侧逆光") &&
      t.includes("- 音效：雨声，木门吱呀") &&
      t.includes("- 提示词：老陈特写，烟气缭绕，雨夜暖光") &&
      t.includes("## 镜2") &&
      t.includes("- 画面：少女推门而入，抖伞") &&
      !t.includes("台词/旁白：少女"),
    "",
  );
} catch (e) {
  check("C1 分镜表 md 每镜一节（风格/字段/镜2仅画面）", false, String(e).slice(0, 120));
}
try {
  const txt = await exportItem("雨夜分镜表", "纯文本");
  const t = txt.text();
  check(
    "C2 分镜表 txt 每镜一节",
    txt.filename === "雨夜分镜表.txt" &&
      t.includes("共 2 镜 · 总时长约 3s") &&
      t.includes("【镜1  特写 · 推 · 3s】") &&
      t.includes("画面：老陈抬头看向门口") &&
      t.includes("【镜2】") &&
      t.includes("画面：少女推门而入，抖伞"),
  );
} catch (e) {
  check("C2 分镜表 txt 每镜一节", false, String(e).slice(0, 120));
}
try {
  const docx = await exportItem("雨夜分镜表", "Word 文档");
  const xml = docxXml(docx.path);
  const zipList = execSync(`unzip -l '${docx.path}'`, { encoding: "utf8" });
  check(
    "C3 分镜表 docx 横版表格（landscape/表头跨页重复/9 列/行内容）",
    docx.filename === "雨夜分镜表.docx" &&
      zipList.includes("[Content_Types].xml") && zipList.includes("word/document.xml") &&
      xml.includes('orient="landscape"') &&
      xml.includes("tblHeader") &&
      xml.includes("镜号") && xml.includes("景别") && xml.includes("运镜") &&
      xml.includes("时长") && xml.includes("画面") && xml.includes("台词/旁白") &&
      xml.includes("光影") && xml.includes("音效") && xml.includes("提示词") &&
      xml.includes("总时长约 3s") &&
      xml.includes("老陈抬头看向门口") &&
      xml.includes("谁在敲门？") &&
      xml.includes("少女推门而入，抖伞") &&
      xml.includes("视觉风格：赛博朋克雨夜"),
  );
} catch (e) {
  check("C3 分镜表 docx 横版表格（landscape/表头跨页重复/9 列/行内容）", false, String(e).slice(0, 120));
}

// ---------- D 空卡守卫 ----------
{
  const emptyBtn = card("空笔记").getByRole("button", { name: "导出文件" });
  await page.waitForTimeout(500);
  check("D1 空文本卡不渲染导出按钮（与生图/生视频同策略）", (await emptyBtn.count()) === 0);
}

check("E1 导出全程无页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));

await browser.close();
rmSync(tmp, { recursive: true, force: true });

// 自清理：删除测试项目
await api(`/projects/${pid}`, { method: "DELETE" });

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log("失败项:", failed.map((f) => f.name).join("；"));
  process.exit(1);
}
