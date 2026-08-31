import { NextRequest } from "next/server";

/**
 * langflow 同源代理（/langflow/* → 127.0.0.1:7860/*，仅平台 admin 可过）。
 * 不用 next.config rewrites：Next 的尾斜杠 308 规范化会先吃掉路径尾斜杠，
 * 而 langflow 的 API 路由全带尾斜杠（/api/v1/flows/ 200、无斜杠 404）。
 * 路由处理器 + skipTrailingSlashRedirect 可原样透传路径。
 * langflow 前端以 BASENAME=/langflow 构建（见 langflow/src/frontend/src/customization/config-constants.ts），
 * 且开 AUTO_LOGIN 免它自己的登录页——身份把关完全在本代理（authorized()）。
 * 限制：WebSocket 不经此代理（langflow 语音助手不可用，其余功能走 HTTP/SSE）。
 */

const TARGET = "http://127.0.0.1:7860";
const AGENT = "http://127.0.0.1:8123";

// 逐跳头不应转发（RFC 7230；host 由 fetch 按目标重写）。
// content-encoding/length 必须剥：undici fetch 已自动解压上游 gzip，
// 原样转发会让客户端按声明的编码再解一次（得到空/损坏 body）。
// accept-encoding 一并剥掉由 undici 自行协商，保证「解码后转发」自洽。
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "accept-encoding",
]);

// ---------- 平台账号守卫（langflow 无自己的鉴权，把关在代理层） ----------
// langflow 开 AUTO_LOGIN 免登录，谁能到这谁就用——所以必须只放行平台 admin。
// verify 结果按 token 缓存 60s，避免 langflow UI 每次 XHR 都打一遍 agent。
const verifyCache = new Map<string, { ok: boolean; until: number }>();
const VERIFY_TTL = 60_000;

async function authorized(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get("wingsight_studio_token")?.value ?? "";
  const cached = verifyCache.get(token);
  if (cached && cached.until > Date.now()) return cached.ok;

  let ok = false;
  try {
    // agent 不可达 → 离线放行（对齐 AuthGate 的离线语义）
    const status = await fetch(`${AGENT}/api/v1/auth/status`, {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    const { enabled } = (await status.json()) as { enabled: boolean };
    if (!enabled) {
      ok = true;
    } else if (token) {
      const v = await fetch(`${AGENT}/api/v1/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
        cache: "no-store",
      });
      if (v.ok) {
        const { role } = (await v.json()) as { role?: string };
        ok = role === "admin";
      }
    }
  } catch {
    ok = true;
  }
  if (token) verifyCache.set(token, { ok, until: Date.now() + VERIFY_TTL });
  return ok;
}

function deny(req: NextRequest): Response {
  // 页面导航引导去登录（带回跳）；XHR 给 401 让 UI 显式失败
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
    return new Response(null, {
      status: 302,
      headers: { location: `/login?from=${encodeURIComponent("/langflow")}` },
    });
  }
  return new Response(JSON.stringify({ detail: "需要平台管理员登录" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

async function proxy(req: NextRequest): Promise<Response> {
  if (!(await authorized(req))) return deny(req);
  const path = req.nextUrl.pathname.replace(/^\/langflow/, "") || "/";
  const target = new URL(path + req.nextUrl.search, TARGET);

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("x-forwarded-prefix", "/langflow");

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    // @ts-expect-error -- Node fetch 的 duplex 透传流式请求体必需
    duplex: "half",
    redirect: "manual",
  });

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    // set-cookie 单独处理：Headers.forEach 会把多条合并成逗号串，浏览器解析即坏
    if (key.toLowerCase() === "set-cookie") return;
    if (!HOP_BY_HOP.has(key.toLowerCase())) resHeaders.set(key, value);
  });
  // langflow 认证就是 HttpOnly cookie（access_token_lf 等），必须逐条透传
  const setCookies = (upstream.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.();
  for (const c of setCookies ?? []) resHeaders.append("set-cookie", c);
  // langflow 的认证 cookie 作用域跟随代理路径即可
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
