import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 关掉左下角的 N 开发指示器（纯开发态装饰，与产品 UI 无关）
  devIndicators: false,

  // langflow 代理（app/langflow/[[...path]]/route.ts）要求路径原样到达处理器：
  // Next 默认把 /a/ 308 成 /a，会吃掉 langflow API 依赖的尾斜杠
  skipTrailingSlashRedirect: true,

  // dev 服务器默认只信任 localhost 来源；放行本机回环/局域网/远程隧道域名
  // （192.168.100.204 = 本机，192.168.31.150 = wingsight 服务器部署内网 IP）
  // ssl.uunat.com = 隧道域名：不在名单时 _next/static 全 403，页面卡在加载中
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "ssl.ddnsto.net",
    "*.ddnsto.net",
    "ssl.uunat.com",
    "*.uunat.com",
    "*.trycloudflare.com",
    "bore.pub",
    "192.168.100.204",
    "192.168.31.150",
  ],

  // agent 服务同源代理：浏览器统一走 /agent-service，
  // 避免经隧道访问时的跨域 / 混合内容问题（https 页面直连 http://localhost:8123 会被拦）。
  // 通用转发（healthz/camera-vocab/skills 等端点曾因白名单漏配而 404）
  async rewrites() {
    return [
      {
        source: "/agent-service/:path*",
        destination: "http://127.0.0.1:8123/:path*",
      },
      {
        source: "/agent-service",
        destination: "http://127.0.0.1:8123/",
      },
      {
        // 认证/用户/API Key（与 juben 的 /api/v1 路径约定一致）
        source: "/api/v1/:path*",
        destination: "http://127.0.0.1:8123/api/v1/:path*",
      },
    ];
  },
};

export default nextConfig;
