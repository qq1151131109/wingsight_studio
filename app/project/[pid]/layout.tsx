import "@copilotkit/react-ui/styles.css";
import "@xyflow/react/dist/style.css";
import { AgentProvider } from "@/app/agent-provider";

/**
 * 画布工作台段布局：CopilotKit + AG-UI 运行时（及其样式）只挂在
 * /project/[pid] 下——首页/管理后台/登录页不再加载聊天栈，dev 冷导航
 * 与首屏的模块图都瘦一大截。样式仍晚于根布局的 globals.css 加载，
 * globals 里的 .react-flow__* 覆盖顺序不变。
 */
export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AgentProvider>{children}</AgentProvider>;
}
