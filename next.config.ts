import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 关掉左下角的 N 开发指示器（纯开发态装饰，与产品 UI 无关）
  devIndicators: false,

  // 关闭 Next 的响应压缩：代理会对上游 SSE（AG-UI 聊天流，text/event-stream）
  // 也做 gzip——gzip 缓冲把整个流攒到结束一次发给浏览器，打字机效果失效
  // （表现为回复"一次性吐出"）。自托管 + 隧道场景无带宽压力，压缩收益为零
  compress: false,

  // 同源代理（rewrites → 8123）对上游 socket 的空闲超时：默认约 30s，
  // 拆解/技能 flow 调用中段的静默期一过就把 AG-UI SSE 流掐断（前端报
  // ERR_INCOMPLETE_CHUNKED_ENCODING / agent network error）。放宽到 10 分钟；
  // 流式数据持续流动时会不断重置计时，真正的死连接最多多挂 10 分钟
  //
  // proxyClientMaxBodySize：代理会把请求体在内存里缓冲一份（供代理与路由
  // 双读），默认上限 10MB——超限的请求整个代理挂死、上游根本收不到（ly
  // 拖 4K 图上传必死的事故：4K PNG 常见 10-25MB）。调到 200MB 对齐 agent
  // 的视频上传上限
  experimental: {
    proxyTimeout: 600_000,
    proxyClientMaxBodySize: "200mb",
  },

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
      {
        // novanova 竞品工作台（references/novanova-studio，basePath=/nova 的
        // next dev :8200）挂在同源 /nova 下试用；其 /nova/api/v1/* 由它自己
        // 的 dev rewrite 转发到 8080 的 Java server——必须排在本文件
        // /api/v1 重写之后无关（前缀不同），但语义上 /nova 优先级独立
        source: "/nova",
        destination: "http://127.0.0.1:8200/nova",
      },
      {
        source: "/nova/:path*",
        destination: "http://127.0.0.1:8200/nova/:path*",
      },
      // novanova 的 public 静态资源在源码里是裸绝对路径（/logo /images
      // /homepage /icons /fonts /github_images），不吃 basePath 前缀——
      // 浏览器按根路径请求会落到本站 404。这些顶层目录本站 public 均未
      // 使用（已核对零冲突），窄转发到 8200 并补 /nova 前缀
      ...[
        "logo",
        "images",
        "homepage",
        "icons",
        "fonts",
        "github_images",
      ].map((dir) => ({
        source: `/${dir}/:path*`,
        destination: `http://127.0.0.1:8200/nova/${dir}/:path*`,
      })),
    ];
  },
};

export default nextConfig;
