"use client";

/** 首次访问欢迎弹窗（对标 novanova welcome-modal；已读状态 localStorage 持久化） */

import { useEffect, useState } from "react";
import { Clapperboard, Rocket, Sparkles, WandSparkles } from "lucide-react";

const ACK_KEY = "wingsight:welcome-acked";

export default function WelcomeModal() {
  const [open, setOpen] = useState(false);

  // 延迟一帧读取已读标记：避免 effect 内同步 setState（级联渲染）与水合不一致
  useEffect(() => {
    const t = setTimeout(() => {
      if (!localStorage.getItem(ACK_KEY)) setOpen(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const ack = () => {
    localStorage.setItem(ACK_KEY, new Date().toISOString());
    setOpen(false);
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface-1 p-6 shadow-2xl">
        <span className="font-editorial flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-lg font-semibold text-white">
          翼
        </span>
        <h2 className="font-editorial mt-3 text-xl font-semibold text-text">
          欢迎来到 Wingsight Studio
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-text-3">
          AI 影视创作无限画布——从一句话到成片的工作台。
        </p>
        <div className="mt-4 flex flex-col gap-2.5 text-xs">
          {[
            {
              icon: <Clapperboard className="h-4 w-4 text-accent" />,
              title: "画布即故事板",
              desc: "剧本、角色、分镜、图片、视频、音频，卡片连线即工作流",
            },
            {
              icon: <WandSparkles className="h-4 w-4 text-accent" />,
              title: "助手帮你搭",
              desc: "右侧聊天直接说「写个剧本并拆成分镜」，卡片自动生成",
            },
            {
              icon: <Sparkles className="h-4 w-4 text-accent" />,
              title: "导演台控镜语",
              desc: "分镜卡上选景别/运镜/机身/布光，编译成摄影语言驱动生成",
            },
          ].map((f) => (
            <div key={f.title} className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0">{f.icon}</span>
              <span>
                <span className="font-medium text-text">{f.title}</span>
                <span className="ml-1.5 text-text-3">{f.desc}</span>
              </span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={ack}
          className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-md bg-accent py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          <Rocket className="h-4 w-4" />
          开始创作
        </button>
      </div>
    </div>
  );
}
