import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dev 服务器默认只信任 localhost 来源；放行本机回环/局域网/远程隧道域名
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "ssl.ddnsto.net",
    "*.ddnsto.net",
    "*.trycloudflare.com",
    "bore.pub",
    "192.168.100.204",
  ],

  // agent 服务同源代理：浏览器统一走 /agent-service，
  // 避免经隧道访问时的跨域 / 混合内容问题（https 页面直连 http://localhost:8123 会被拦）
  async rewrites() {
    return [
      {
        source: "/agent-service",
        destination: "http://127.0.0.1:8123/",
      },
      {
        source: "/agent-service/assets/:path*",
        destination: "http://127.0.0.1:8123/assets/:path*",
      },
      {
        source: "/agent-service/projects/:path*",
        destination: "http://127.0.0.1:8123/projects/:path*",
      },
    ];
  },
};

export default nextConfig;
