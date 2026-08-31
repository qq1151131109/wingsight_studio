import { NextRequest } from "next/server";

/**
 * langflow 同源代理（/langflow/* → 127.0.0.1:7860/*）。
 * 不用 next.config rewrites：Next 的尾斜杠 308 规范化会先吃掉路径尾斜杠，
 * 而 langflow 的 API 路由全带尾斜杠（/api/v1/flows/ 200、无斜杠 404）。
 * 路由处理器 + skipTrailingSlashRedirect 可原样透传路径。
 * langflow 前端以 BASENAME=/langflow 构建（见 langflow/src/frontend/src/customization/config-constants.ts）。
 * 限制：WebSocket 不经此代理（langflow 语音助手不可用，其余功能走 HTTP/SSE）。
 */

const TARGET = "http://127.0.0.1:7860";

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

async function proxy(req: NextRequest): Promise<Response> {
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
    if (!HOP_BY_HOP.has(key.toLowerCase())) resHeaders.set(key, value);
  });
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
