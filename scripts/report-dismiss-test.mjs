/**
 * 「删了就不再来」回归（纯函数层，无浏览器 / 无 LLM）。
 *
 * 2026-09-10 用户拍板：考证报告卡 / 大纲卡被用户删掉后，对账不再重建
 * （与参考卡「删卡=取消采纳」同语义）。报告卡没有服务端采纳凭据，故删除
 * 标记记在项目 meta.dismissedReports，由 store.deleteNodes 落、refReconcile
 * 的 upsertDocCard 读。本脚本锁住 store 侧的两个行为：只有带 reportKind 的
 * 卡被删才记、别的卡不记。
 *
 * 运行：pnpm dlx tsx scripts/report-dismiss-test.mjs
 */
import { saneDismissedReports, useCanvasStore } from "../lib/canvas/store.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

const st = () => useCanvasStore.getState();
const VP = { x: 0, y: 0, zoom: 1 };

st().replaceCanvas(
  [
    {
      id: "r1",
      type: "note",
      position: { x: 0, y: 0 },
      data: {
        nodeType: "note",
        title: "考证报告",
        body: "x",
        reportKind: "ref-research",
      },
    },
    {
      id: "n1",
      type: "note",
      position: { x: 0, y: 0 },
      data: { nodeType: "note", title: "普通卡", body: "y" },
    },
  ],
  [],
  VP,
);

check("初始无删除标记", st().dismissedReports.length === 0);

st().deleteNodes(["n1"]);
check("删普通卡不记标记", st().dismissedReports.length === 0);

st().deleteNodes(["r1"]);
check(
  "删报告卡记下 kind",
  st().dismissedReports.length === 1 &&
    st().dismissedReports.includes("ref-research"),
  JSON.stringify(st().dismissedReports),
);

st().deleteNodes(["r1"]);
check(
  "重复删除不堆重复项",
  st().dismissedReports.length === 1,
  JSON.stringify(st().dismissedReports),
);

check(
  "saneDismissedReports 去重",
  saneDismissedReports(["a", "a", "b"]).length === 2,
);
check(
  "saneDismissedReports 滤掉非字符串与空白",
  saneDismissedReports(["a", 1, null, "", "   "]).join(",") === "a",
);
check(
  "saneDismissedReports 上限 8 条",
  saneDismissedReports(Array.from({ length: 20 }, (_, i) => `k${i}`)).length === 8,
);
check("saneDismissedReports 非数组回落空", saneDismissedReports(null).length === 0);

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
