"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { apiFetch } from "@/lib/auth";

/**
 * DMX 余额 chip（仅管理员，AccountMenu 挂载 → 首页/画布顶栏同时生效）。
 * 余额经 agent 同源代理查询（DMX 密钥只在服务端），挂载即拉 + 60s 轮询 +
 * 回到前台立即刷新，点击手动刷新；失败保留最后一次数值（灰色提示），不打扰。
 */

interface DmxBalanceData {
  /** 剩余额度（人民币；DMX 的 one-api 内核里 hard_limit_usd 字段实为剩余） */
  remaining: number;
  /** 累计已用（人民币） */
  used: number;
  /** 今日消耗（北京时区日界，agent 基线差分） */
  today_used: number;
  today_date: string;
  currency: string;
  /** 服务端查询时间（unix 秒） */
  checked_at: number;
}

const fmt = (n: number) =>
  n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function fetchBalance(): Promise<DmxBalanceData> {
  const r = await apiFetch("/agent-service/api/v1/dmx/balance");
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.detail ?? `HTTP ${r.status}`);
  return body as DmxBalanceData;
}

export default function DmxBalance() {
  const [bal, setBal] = useState<DmxBalanceData | null>(null);
  const [err, setErr] = useState("");

  // 初始拉取（内联 IIFE：setState 全部在 await 之后，React Compiler lint 口径）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const b = await fetchBalance();
        if (!alive) return;
        setBal(b);
        setErr("");
      } catch (e) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : "查询失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 30s 自动轮询 + 回到前台立即刷新（回调里的 setState 不受 effect lint 约束）
  const refresh = useCallback(() => {
    fetchBalance()
      .then((b) => {
        setBal(b);
        setErr("");
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "查询失败"));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // 首拉未回且无缓存：不占位，避免顶栏跳动
  if (!bal && !err) return null;

  const tip = bal
    ? `DMX 余额 ¥${fmt(bal.remaining)} · 今日(北京) ¥${fmt(bal.today_used)} · 累计已用 ¥${fmt(bal.used)} · 更新于 ${new Date(bal.checked_at * 1000).toLocaleTimeString("zh-CN")}（每 30 秒自动更新，点击立即刷新）${err ? ` 上次失败：${err}` : ""}`
    : `DMX 余额查询失败：${err} · 点击重试`;

  return (
    <button
      type="button"
      data-tip={tip} aria-label="DMX 余额"
      onClick={() => refresh()}
      className={`flex cursor-pointer items-center gap-1 rounded-md border border-hairline bg-surface-1 px-2 py-1 text-[11px] tabular-nums transition-colors hover:bg-surface-2 ${
        err ? "text-text-4" : "text-text-2"
      }`}
    >
      <Wallet className="h-3 w-3 shrink-0 text-text-4" />
      {bal ? (
        <>
          DMX ¥{fmt(bal.remaining)}
          <span className="text-text-4">·</span>
          今日 ¥{fmt(bal.today_used)}
        </>
      ) : (
        "DMX —"
      )}
    </button>
  );
}
