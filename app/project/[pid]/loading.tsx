/** 画布路由加载骨架（模仿画布布局，避免白屏跳变；对标 open-ai-canvas refresh shell） */
export default function Loading() {
  return (
    <div className="flex h-dvh animate-pulse bg-bg">
      <div className="w-14 border-r border-hairline" />
      <div className="relative m-4 flex-1">
        <div className="absolute left-0 top-0 h-10 w-72 rounded-lg border border-hairline bg-surface-2" />
        <div className="absolute bottom-14 left-1/2 h-10 w-72 -translate-x-1/2 rounded-lg border border-hairline bg-surface-2" />
        <div className="absolute right-0 top-0 h-full w-72 border-l border-hairline" />
        <div className="absolute left-1/4 top-1/4 h-40 w-64 rounded-xl border border-hairline bg-surface-2/60" />
        <div className="absolute right-1/3 bottom-1/4 h-32 w-56 rounded-xl border border-hairline bg-surface-2/60" />
      </div>
    </div>
  );
}
