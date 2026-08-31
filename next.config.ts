import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 关掉左下角的 N 开发指示器（纯开发态装饰，与产品 UI 无关）
  devIndicators: false,

  // dev 服务器默认只信任 localhost 来源；放行本机回环/局域网/远程隧道域名
  // （192.168.100.204 = 本机，192.168.31.150 = wingsight 服务器部署内网 IP）
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "ssl.ddnsto.net",
    "*.ddnsto.net",
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
