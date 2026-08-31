// 子路径部署（wingsight 定制）：langflow 经 Next 同源代理暴露在 /langflow/*
// （代理剥前缀转发 127.0.0.1:7860）。BASENAME 供 vite base 与 React Router；
// URL 常量带前缀，直连 fetch（不经 axios baseURL）也能落到代理上。
export const BASENAME = "/langflow";
export const PORT = 3000;
export const PROXY_TARGET = "http://localhost:7860";
export const API_ROUTES = [
  "^/langflow/api/v1/",
  "^/langflow/api/v2/",
  "/langflow/health",
];
export const BASE_URL_API = "/langflow/api/v1/";
export const BASE_URL_API_V2 = "/langflow/api/v2/";
export const HEALTH_CHECK_URL = "/langflow/health_check";
export const DOCS_LINK = "https://docs.langflow.org";

export default {
  DOCS_LINK,
  BASENAME,
  PORT,
  PROXY_TARGET,
  API_ROUTES,
  BASE_URL_API,
  BASE_URL_API_V2,
  HEALTH_CHECK_URL,
};
