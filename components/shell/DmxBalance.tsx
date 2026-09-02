"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wallet } from "lucide-react";
import { apiFetch } from "@/lib/auth";

/**
 * DMX 余额 + 出图用量 chip（仅管理员，AccountMenu 挂载 → 首页/画布顶栏同时生效）。
 * 数据经 agent 同源代理查询（DMX 密钥只在服务端）：挂载即拉 + 30s 自动轮询 +
 * 回到前台立即刷新；点击打开明细面板（各用户出图张数/模型分布）。
 * 失败保留最后一次数值（置灰），不打扰。
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

interface ImageUsageUser {
  user: string;
  today: number;
  total: number;
  models_today: Record<string, number>;
  models_total: Record<string, number>;
}

interface ImageUsage {
  today_date: string;
  users: ImageUsageUser[];
}

const fmt = (n: number) =>
  n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function fetchBalance(): Promise<DmxBalanceData> {
  const r = await apiFetch("/agent-service/api/v1/dmx/balance");
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.detail ?? `HTTP ${r.status}`);
  return body as DmxBalanceData;
}

async function fetchImageUsage(): Promise<ImageUsage> {
  const r = await apiFetch("/agent-service/api/v1/usage/images");
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.detail ?? `HTTP ${r.status}`);
  return body as ImageUsage;
}

export default function DmxBalance() {
  const [bal, setBal] = useState<DmxBalanceData | null>(null);
  const [err, setErr] = useState("");
  const [usageData, setUsageData] = useState<ImageUsage | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // 面板打开即刷新余额 + 拉用量；Escape/点外面收起
  useEffect(() => {
    if (!open) return;
    refresh();
    void fetchImageUsage()
      .then(setUsageData)
      .catch(() => setUsageData(null));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
    // refresh 稳定（useCallback []），open 是唯一触发源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 首拉未回且无缓存：不占位，避免顶栏跳动
  if (!bal && !err) return null;

  const tip = bal
    ? `DMX 余额 ¥${fmt(bal.remaining)} · 今日(北京) ¥${fmt(bal.today_used)} · 累计已用 ¥${fmt(bal.used)} · 点击看出图用量（每 30 秒自动更新）${err ? ` 上次失败：${err}` : ""}`
    : `DMX 余额查询失败：${err} · 点击重试`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-tip={tip} aria-label="DMX 余额与出图用量"
        onClick={() => setOpen((v) => !v)}
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

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1.5 flex max-h-[70vh] w-64 flex-col overflow-auto rounded-lg border border-hairline bg-surface-1 p-2.5 shadow-lg">
          <p className="text-[11px] font-medium text-text">DMX 账户</p>
          {bal ? (
            <div className="mt-1 space-y-0.5 text-[11px] tabular-nums text-text-2">
              <p>余额 ¥{fmt(bal.remaining)}</p>
              <p>今日已用 ¥{fmt(bal.today_used)}</p>
              <p className="text-text-4">累计已用 ¥{fmt(bal.used)}</p>
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-danger">{err || "查询中…"}</p>
          )}

          <div className="my-2 h-px bg-hairline" />
          <p className="text-[11px] font-medium text-text">
            出图用量{usageData ? `（${usageData.today_date} 北京）` : ""}
          </p>
          {usageData === null ? (
            <p className="mt-1 text-[11px] text-text-4">加载中…</p>
          ) : usageData.users.length === 0 ? (
            <p className="mt-1 text-[11px] text-text-4">还没有出图记录</p>
          ) : (
            <div className="mt-1 space-y-1.5">
              {usageData.users.map((u) => (
                <div key={u.user}>
                  <p className="flex items-baseline justify-between gap-2 text-[11px] text-text-2">
                    <span className="min-w-0 truncate">{u.user}</span>
                    <span className="shrink-0 tabular-nums">
                      今日 {u.today} · 累计 {u.total}
                    </span>
                  </p>
                  <p className="truncate text-[10px] text-text-4">
                    {Object.entries(u.models_total)
                      .sort((a, b) => b[1] - a[1])
                      .map(([m, n]) => `${m}×${n}`)
                      .join(" · ")}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-text-4">
            张数为成功出图数（含聊天/资产/分镜全通道）；每 30 秒自动更新。
          </p>
        </div>
      ) : null}
    </div>
  );
}
