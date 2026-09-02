/** 分镜表生成 API：shotlist 卡一键生成（剧本 → rows）。
 *  链路：前端 → 同源代理 /agent-service → agent /storyboard/generate
 *  → langflow「分镜表生成」flow（agent/flows/shotlist-generate.json）。 */
import { apiFetch } from "@/lib/auth";
import { useCanvasStore } from "@/lib/canvas/store";
import type { ShotRow } from "@/lib/canvas/store";
import type { ImagegenParams } from "@/lib/imagegen";

export async function generateShotlist(
  script: string,
  opts?: {
    shotCount?: number;
    durationSeconds?: number;
    visualStyle?: string;
    /** 画布已有资产名单（类型化）：分镜 @名称 引用 + 角色硬约束 */
    assets?: { type: string; name: string }[];
    /** 文本模型覆盖（agent/models.py 目录 id，空=flow 出厂模型） */
    model?: string;
  },
): Promise<ShotRow[]> {
  const start = await apiFetch("/agent-service/storyboard/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, ...opts }),
  });  if (!start.ok) {
    const detail = (await start.text()).slice(0, 160);
    throw new Error(detail || `生成任务启动失败（${start.status}）`);
  }
  const { jobId } = (await start.json()) as { jobId?: string };
  if (!jobId) throw new Error("生成任务启动失败");

  // 轮询（代理 30s 掐断长请求，生成必须异步）。agent 侧等待上限 900s
  // （分镜表实测可到 13 分钟+），前端轮询窗口放宽到 15.5 分钟兜住它
  const deadline = Date.now() + 15.5 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const r = await apiFetch(`/agent-service/storyboard/generate/${jobId}`);
    if (!r.ok) throw new Error(`生成任务查询失败（${r.status}）`);
    const data = (await r.json()) as {
      status: "running" | "done";
      rows?: ShotRow[] | null;
      error?: string;
    };
    if (data.status === "done") {
      if (data.error) throw new Error(data.error);
      return data.rows ?? [];
    }
    if (Date.now() > deadline) throw new Error("生成超时");
  }
}

export type DecomposedLook = {
  label: string;
  description: string;
  /** 该造型的核心服装名（与服饰卡按名对上后连 服饰→Look 边） */
  costume?: string;
  /** 全自动出图链产物：定妆照生成后 Look 图的 /agent-service/assets/ 路径 */
  image_url?: string;
  error?: string;
};

export type DecomposedAsset = {
  type: "character" | "scene" | "prop" | "costume";
  name: string;
  description: string;
  visual_notes: string;
  /** 全自动出图链产物：角色定妆照 / 场景概念图 / 道具与服饰的设定图 */
  image_url?: string;
  /** 角色拆解 flow 输出的造型/服饰变化计划（juben look 范式） */
  looks?: DecomposedLook[];
};

/** 画布已有资产：name 供拆解沿用旧名；image_url（卡上定妆照/设定图）供
 *  自动链给已有角色补 Look 时做身份锚点；looks（角色已有 Look 卡的造型名）
 *  供重拆时对名跳过、不重出同款造型 */
export type ExistingAsset = {
  type: string;
  name: string;
  image_url?: string;
  looks?: string[];
};

export async function decomposeAssets(
  script: string,
  existing?: ExistingAsset[],
  opts?: {
    /** 全自动：拆解后 agent 直接跑角色出图链（定妆照→逐 Look） */
    autoLooks?: boolean;
    /** 项目画风，注入每张出图的视觉风格约束 */
    visualStyle?: string;
    /** 阶段/进度回调（decompose → images{n/total} → done），供卡上进度文案 */
    onPhase?: (p: {
      phase: string;
      progress?: { done: number; total: number };
    }) => void;
    /** 拆解文本模型覆盖（agent/models.py 目录 id，空=flow 出厂模型；出图链不受影响） */
    model?: string;
  },
): Promise<{
  assets: DecomposedAsset[];
  errors: Record<string, string>;
  imagesNote?: string;
}> {
  // 异步任务 + 轮询（代理 30s 掐断长请求，三路拆解 flow 并发也常超 30s）
  const start = await apiFetch("/agent-service/assets/decompose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script,
      existing,
      auto_looks: opts?.autoLooks ?? false,
      visual_style: opts?.visualStyle ?? "",
      // 全自动出图链沿用项目级出图设置（同 startShotImageJob）
      ...(opts?.autoLooks
        ? { params: useCanvasStore.getState().imagegen }
        : {}),
      ...(opts?.model ? { text_model: opts.model } : {}),
    }),
  });
  if (!start.ok) {
    const detail = (await start.text()).slice(0, 160);
    throw new Error(detail || `拆解任务启动失败（${start.status}）`);
  }
  const { jobId } = (await start.json()) as { jobId?: string };
  if (!jobId) throw new Error("拆解任务启动失败");
  // 全自动出图链可能数分钟，轮询上限放宽到 12 分钟
  const deadline = Date.now() + (opts?.autoLooks ? 12 : 5) * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const r = await apiFetch(`/agent-service/assets/decompose/${jobId}`);
    if (!r.ok) throw new Error(`拆解任务查询失败（${r.status}）`);
    const data = (await r.json()) as {
      status: "running" | "done";
      phase?: string;
      progress?: { done: number; total: number } | null;
      assets?: DecomposedAsset[] | null;
      errors?: Record<string, string>;
      error?: string;
      images_note?: string;
    };
    if (data.phase) {
      opts?.onPhase?.({ phase: data.phase, progress: data.progress ?? undefined });
    }
    if (data.status === "done") {
      if (data.error) throw new Error(data.error);
      return {
        assets: data.assets ?? [],
        errors: data.errors ?? {},
        imagesNote: data.images_note,
      };
    }
    if (Date.now() > deadline) throw new Error("拆解超时");
  }
}

/** 分镜行批量出图请求（直连 imagegen flow，不经聊天）。
 *  description 传最终提示词或按行字段合成；visualNotes 并入一致性参考描述；
 *  referenceImages 传角色定妆照 URL（一致性锚点，flow 下载作参考图）；
 *  referenceLabels 与 referenceImages 一一对应（{type,name}），flow 渲染
 *  逐张职责声明（juben build_reference_usage 范式：定妆照只锁身份不继承
 *  白底/多视图排版）；
 *  assetType 决定布局契约（角色 16:9 四格 / 道具 4:3 / 镜头单幅剧照，
 *  缺省 scene），aspect 覆写幅面（分镜图 9:16/21:9；资产卡经 data.gen.aspect
 *  也会落到这里）；params 为镜头级模型/档位/画幅覆盖（卡片级 data.gen，
 *  赢过请求级 params） */
export type ShotImageRequest = {
  rid: string;
  name: string;
  description: string;
  visualNotes?: string;
  assetType?: "character" | "scene" | "prop" | "shot";
  referenceImages?: string[];
  referenceLabels?: { type: string; name: string }[];
  aspect?: string;
  /** 改图模式：最小提示词模板（flow 的 prompt_template 组件入参整体替换
   *  默认模板，去掉四格/空镜/剧照版式措辞），agent 原样注入 tweak */
  promptTemplate?: string;
  params?: ImagegenParams;
};

export type ShotImageResult = {
  rid: string;
  ok: boolean;
  imageUrl?: string;
  error?: string;
};

/** 任务表在 agent 内存里：agent 重启后旧 jobId 查无此任务（区别于网络
 *  抖动，调用方可据此把 loading 图卡置败、清除断点旗标） */
export class ShotJobGoneError extends Error {}

/** 轮询批量出图任务：每张完成即回调 onItem。返回 done/timeout/gone
 *  （gone=agent 重启丢内存任务表）。单次网络抖动不判死；窗口参数是
 *  「无进展空转」时长——每有新图完成即续期，批量再大也不会总时长误判
 *  超时，只有任务彻底卡死（连续 10 分钟零进展）才放弃。
 *  批量出图、刷新恢复与面板直连出图共用 */
export async function pollShotImageJob(
  jobId: string,
  onItem: (item: ShotImageResult) => void,
  stallMs = 10 * 60 * 1000,
): Promise<"done" | "timeout" | "gone" | "cancelled"> {
  let stallDeadline = Date.now() + stallMs;
  const applied = new Set<string>();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    let job;
    try {
      job = await getShotImageJob(jobId);
    } catch (exc) {
      if (exc instanceof ShotJobGoneError) return "gone";
      if (Date.now() > stallDeadline) return "timeout";
      continue;
    }
    let fresh = 0;
    for (const item of job.images) {
      if (applied.has(item.rid) || (!item.ok && !item.error)) continue;
      applied.add(item.rid);
      fresh += 1;
      onItem(item);
    }
    if (fresh > 0) stallDeadline = Date.now() + stallMs;
    if (job.status === "done") return "done";
    if (job.status === "cancelled") return "cancelled";
    if (Date.now() > stallDeadline) return "timeout";
  }
}

/** 启动批量出图任务：Next 同源代理 30s 掐断长请求，必须异步任务 + 轮询。
 *  params 缺省取项目级出图设置（store.imagegen，底部坞「出图」），
 *  服务端按模型目录校验模型/档位/画幅（请求级缺省，镜头级覆盖），非法
 *  组合 400 明报 */
export async function startShotImageJob(
  shots: ShotImageRequest[],
  params?: ImagegenParams,
): Promise<string> {
  const r = await apiFetch("/agent-service/storyboard/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shots,
      params: params ?? useCanvasStore.getState().imagegen,
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 160);
    throw new Error(detail || `批量出图启动失败（${r.status}）`);
  }
  const data = (await r.json()) as { jobId?: string };
  if (!data.jobId) throw new Error("批量出图任务启动失败");
  return data.jobId;
}

/** 取消出图任务：未开跑的镜头跳过，在途的中止底层请求（不再计费）。
 *  任务不存在/已结束返回 false（前端按已结束处理即可） */
export async function cancelShotImageJob(jobId: string): Promise<boolean> {
  const r = await apiFetch(`/agent-service/storyboard/images/${jobId}`, {
    method: "DELETE",
  });
  return r.ok;
}

export async function getShotImageJob(jobId: string): Promise<{
  status: "running" | "done" | "cancelled";
  images: ShotImageResult[];
}> {
  const r = await apiFetch(`/agent-service/storyboard/images/${jobId}`);
  if (r.status === 404) throw new ShotJobGoneError("出图任务不存在（agent 可能已重启）");
  if (!r.ok) throw new Error(`出图任务查询失败（${r.status}）`);
  return (await r.json()) as {
    status: "running" | "done" | "cancelled";
    images: ShotImageResult[];
  };
}

/** 资产设定图生成：复用批量出图任务通道，按资产类型定幅面与布局；
 *  params 透传卡片级出图覆盖（data.gen 的 model/resolution/aspect），
 *  aspect 显式画幅覆写（空=按类型默认幅面） */
export async function startCharacterImageJob(opts: {
  rid: string;
  name: string;
  description: string;
  assetType?: "character" | "scene" | "prop";
  visualNotes?: string;
  aspect?: string;
  params?: ImagegenParams;
}): Promise<string> {
  const { params, ...shot } = opts;
  return startShotImageJob(
    [{ ...shot, assetType: opts.assetType ?? "character" }],
    params,
  );
}
