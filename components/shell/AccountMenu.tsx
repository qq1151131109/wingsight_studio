"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LogOut, ShieldCheck, Workflow } from "lucide-react";
import { clearToken } from "@/lib/auth";
import {
  getAuthSession,
  peekAuthSession,
  type AuthSession,
} from "@/lib/auth-session";
import PasswordDialog from "./PasswordDialog";

/** 用户名 → 稳定头像色（oklch 色相环 8 色轮换；协作者头像同款方案） */
const AVATAR_HUES = [30, 80, 140, 180, 220, 270, 320, 5];
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `oklch(0.62 0.11 ${AVATAR_HUES[h % AVATAR_HUES.length]})`;
}

/**
 * 账户菜单（对标竞品头像下拉范式，novanova user-status-actions 同构）：
 * 头像（登录名首字 + 稳定色）常驻 → 下拉 = 用户信息头 + 修改密码（成员）/
 * 管理后台（仅 admin）+ 退出登录。认证关闭（单机模式）不渲染。
 * 首页 / 画布顶栏共用，项目级入口不再各自散落。
 */
export default function AccountMenu() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(() =>
    peekAuthSession(),
  );
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) void getAuthSession().then(setSession);
  }, [session]);

  // Escape 收起（焦点在菜单外也生效，与全站弹窗一致）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 菜单开着时点击菜单外区域收起（overlay 兜不住的：滚动、右键等）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!session?.enabled) return null;
  const name = session.username ?? "";
  const isAdmin = session.role === "admin";

  const logout = () => {
    clearToken();
    // 故意整页跳转：登出必须清掉全部内存态（store/缓存），router.push 不卸载模块
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-tip={isAdmin ? `管理员 ${name}（账户菜单）` : `账户菜单（${name}）`} aria-label={isAdmin ? `管理员 ${name}（账户菜单）` : `账户菜单（${name}）`}
        onClick={() => setOpen((v) => !v)}
        className="grid h-8 w-8 place-items-center rounded-full border border-surface-1 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-85"
        style={{ background: avatarColor(name) }}
      >
        {name.slice(0, 1).toUpperCase() || "?"}
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1.5 flex w-44 flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          <div
            className="px-2 py-1.5"
            title={
              isAdmin ? "admin 密码经服务端 .env.local 的 AUTH_PASSWORD 修改" : undefined
            }
          >
            <p className="truncate text-sm font-medium text-text">{name}</p>
            <p className="text-[11px] text-text-3">{isAdmin ? "管理员" : "成员"}</p>
          </div>
          <div className="my-1 h-px bg-hairline" />
          {!isAdmin ? (
            <MenuButton
              icon={<KeyRound className="h-3.5 w-3.5" />}
              label="修改密码"
              onClick={() => {
                setOpen(false);
                setChanging(true);
              }}
            />
          ) : null}
          {isAdmin ? (
            <MenuButton
              icon={<ShieldCheck className="h-3.5 w-3.5" />}
              label="管理后台"
              onClick={() => {
                setOpen(false);
                router.push("/admin");
              }}
            />
          ) : null}
          {isAdmin ? (
            <MenuButton
              icon={<Workflow className="h-3.5 w-3.5" />}
              label="Langflow"
              onClick={() => {
                setOpen(false);
                // langflow 独立端口（setup-langflow.sh 起在 7860），绑同机；
                // 用当前 host 拼地址：本机 dev= localhost:7860，服务器内网= 内网IP:7860
                window.open(
                  `${location.protocol}//${location.hostname}:7860/`,
                  "_blank",
                  "noopener",
                );
              }}
            />
          ) : null}
          <MenuButton
            icon={<LogOut className="h-3.5 w-3.5" />}
            label="退出登录"
            danger
            onClick={logout}
          />
        </div>
      ) : null}

      {changing ? <PasswordDialog onClose={() => setChanging(false)} /> : null}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 ${
        danger ? "text-danger" : "text-text-2 hover:text-text"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
