/**
 * run 级重试纯函数回归（lib/chat/runRetry.ts）：
 *  1. 停止/卸载类错误不重试（AbortError / "component unmounted"）
 *  2. 传输层错误可重试（TypeError: Failed to fetch / network error / 截断）
 *  3. 退避表 1s → 2s（封顶 5s）
 *  4. 残片剥离：只保留 run 前消息（baseline），无 id 的消息保留（防御）
 * 运行：pnpm dlx tsx scripts/run-retry-test.mjs（纯函数无 LLM）
 */
import { isRetryableRunError, retryDelayMs, keepBaselineMessages } from "../lib/chat/runRetry.ts";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- 1. 不重试：停止/卸载 ----------
{
  const abort = new Error("The user aborted a request.");
  abort.name = "AbortError";
  check("A1 AbortError 不重试", isRetryableRunError(abort) === false);
  check("A2 消息含 abort 不重试", isRetryableRunError(new Error("Fetch is aborted")) === false);
  check("A3 component unmounted 不重试", isRetryableRunError(new Error("component unmounted")) === false);
  check("A4 unmount 大小写不敏感", isRetryableRunError(new Error("Component Unmounted now")) === false);
}

// ---------- 2. 可重试：传输层 ----------
{
  check("B1 TypeError: Failed to fetch 可重试", isRetryableRunError(new TypeError("Failed to fetch")) === true);
  check("B2 network error 可重试", isRetryableRunError(new TypeError("network error")) === true);
  check("B3 SSE 截断可重试", isRetryableRunError(new Error("ERR_INCOMPLETE_CHUNKED_ENCODING")) === true);
  check("B5 未知错误缺省可重试（服务端语义错误走事件通道不会到这里）", isRetryableRunError(new Error("whatever")) === true);
}

// ---------- 3. 退避表 ----------
{
  check("C1 第 1 次退避 1s", retryDelayMs(1) === 1000);
  check("C2 第 2 次退避 2s", retryDelayMs(2) === 2000);
  check("C3 封顶 5s", retryDelayMs(5) === 5000);
}

// ---------- 4. 残片剥离 ----------
{
  const baseline = new Set(["u1", "a1", "r1"]);
  const current = [
    { id: "u1", role: "user" },
    { id: "r1", role: "reasoning" },
    { id: "a1", role: "assistant" },
    { id: "lc_run--X", role: "assistant" }, // 失败尝试的残片
    { id: "lc_run--Y", role: "assistant" }, // 残片
  ];
  const kept = keepBaselineMessages(baseline, current);
  check("D1 剥掉 run 后新增的残片", kept.length === 3 && !kept.some((m) => m.id.startsWith("lc_run--")));
  check("D2 baseline 全保留（含 reasoning）", kept.some((m) => m.id === "r1"));
  check("D3 无 id 消息保留（防御：不该因剥离丢消息）", keepBaselineMessages(baseline, [{ role: "x" }]).length === 1);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\n全部通过（${results.length} 项）` : `\n${failed.length} 项失败`);
process.exit(failed.length === 0 ? 0 : 1);
