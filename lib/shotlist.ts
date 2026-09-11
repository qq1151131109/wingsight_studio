/** 分镜表生成 API：shotlist 卡一键生成（剧本 → rows）。
 *  链路：前端 → 同源代理 /agent-service → agent /storyboard/generate
 *  → langflow「分镜表生成」flow（agent/flows/shotlist-generate.json）。 */
import { apiFetch } from "@/lib/auth";
import { useCanvasStore } from "@/lib/canvas/store";
import type { ShotRow } from "@/lib/canvas/store";
import { findModelOption, loadImageModels, type ImagegenParams, type VideogenParams } from "@/lib/imagegen";
import { showToast } from "@/lib/toast";

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
): Promise<{
  rows: ShotRow[];
  /** 分镜引用了但画布上没有对应卡的资产名（顺序去重）——换装服饰/关键
   *  道具漏拆的唯一发现回路，调用方必须提示用户补建，不要静默丢弃 */
  missingAssets: string[];
}> {
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
      missingAssets?: string[] | null;
      error?: string;
    };
    if (data.status === "done") {
      if (data.error) throw new Error(data.error);
      return { rows: data.rows ?? [], missingAssets: data.missingAssets ?? [] };
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
  /** 任务中断（agent 重启）但带回了部分产物：assets 里已生成的图照常落卡，
   *  调用方须把这句错误如实转达给用户 */
  interrupted?: string;
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
      // 终态事件流按项目路由（TaskEvents 通知过滤）
      project_id: useCanvasStore.getState().projectId,
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
      if (data.error) {
        // 中断（agent 重启等）带部分产物：已花钱生成的设定图随 assets 收回
        // （照常落卡），错误如实转达——不是全有或全无
        const partial = data.assets ?? [];
        if (partial.length > 0)
          return {
            assets: partial,
            errors: data.errors ?? {},
            imagesNote: data.images_note,
            interrupted: data.error,
          };
        throw new Error(data.error);
      }
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
 *  assetType 决定布局契约（角色 16:9 四格 / 道具结构图 / 镜头单幅剧照 /
 *  none=无版式直传，缺省 scene），aspect 覆写幅面（分镜图 9:16/21:9；
 *  资产卡经 data.gen.aspect 也会落到这里）；params 为镜头级模型/档位/画幅
 *  覆盖（卡片级 data.gen，赢过请求级 params） */
export type ShotImageRequest = {
  rid: string;
  name: string;
  description: string;
  visualNotes?: string;
  assetType?: "character" | "scene" | "prop" | "costume" | "shot" | "none";
  referenceImages?: string[];
  referenceLabels?: { type: string; name: string }[];
  aspect?: string;
  /** 改图模式：最小提示词模板（flow 的 prompt_template 组件入参整体替换
   *  默认模板，去掉四格/空镜/剧照版式措辞），agent 原样注入 tweak */
  promptTemplate?: string;
  /** 智能编排：出图前先经「指令合成」flow 把 instruction+setting 扩写成
   *  完整提示词（novanova KEEP/OPTIMIZE），合成结果随任务项回传 */
  compose?: boolean;
  /** 智能编排的原始指令（compose=true 时必填） */
  instruction?: string;
  /** 智能编排的卡片设定文本（compose=true 时供扩写上下文） */
  setting?: string;
  /** 完整提示词整体替换（「实际提示词」编辑重跑）：原样出图不经版式渲染 */
  finalPrompt?: string;
  params?: ImagegenParams;
};

export type ShotImageResult = {
  rid: string;
  ok: boolean;
  imageUrl?: string;
  error?: string;
  /** 智能编排合成后的最终提示词（compose=true 的任务项回传，回显用） */
  composedPrompt?: string;
  composeAction?: "keep" | "optimize";
  /** 实际发送的完整提示词（服务端渲染或 final_prompt 原样） */
  finalPrompt?: string;
  /** 未考证留痕（真实题材补考据软失败）：图照出但没带考据依据，
   *  卡片「节点信息」里可见，不该是无声裸奔 */
  researchNote?: string;
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
  let refGapNotified = false;
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
    // 参考图核查提示（画布侧，与聊天侧 ref_gap 同口径，只弹一次）：画布上直接
    // 点生成不经过 agent，用户拿不到那句提醒——这批只有文字考据约束形制、
    // 没有实物比对依据（091101 武则天事故：52 张资产考据全到、参考图 0 张）。
    // 只提示不拦：图照出，用户知道「形制靠文字、长相没比对」即可。
    if (!refGapNotified && job.refGap.length > 0) {
      refGapNotified = true;
      const shown = job.refGap.slice(0, 4).join("、");
      const more = job.refGap.length > 4 ? ` 等 ${job.refGap.length} 个` : "";
      showToast(
        `${job.refGap.length} 项没有参考图（只有文字考据约束形制）：${shown}${more}。` +
          `建议先做参考图调研（画布「调研」入口 / 考证报告卡「补调研」），补完再重出这一批`,
      );
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
  let effective = params ?? useCanvasStore.getState().imagegen;
  // 卡片级 gen 整对象替换项目级，但卡片弹窗没有质量档选择器——缺 quality
  // 时继承项目级（前提：卡模型支持该档，否则硬带会被 agent 400）
  if (params && !params.quality) {
    const project = useCanvasStore.getState().imagegen;
    if (project.quality) {
      const entry = findModelOption(
        params.model,
        await loadImageModels().catch(() => null),
      );
      if (entry?.qualities?.includes(project.quality)) {
        effective = { ...params, quality: project.quality };
      }
    }
  }
  const r = await apiFetch("/agent-service/storyboard/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shots,
      params: effective,
      // 终态事件流按项目路由（TaskEvents 通知过滤）
      project_id: useCanvasStore.getState().projectId,
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
  /** 本批**实际没带参考图**的项（真实题材才有，口径同聊天侧 ref_gap）：
   *  这批只有文字考据约束形制、没有实物比对依据。只提示不拦——用户要出就得能出 */
  refGap: string[];
}> {
  const r = await apiFetch(`/agent-service/storyboard/images/${jobId}`);
  if (r.status === 404) throw new ShotJobGoneError("出图任务不存在（agent 可能已重启）");
  if (!r.ok) throw new Error(`出图任务查询失败（${r.status}）`);
  const data = (await r.json()) as {
    status: "running" | "done" | "cancelled";
    images: ShotImageResult[];
    ref_gap?: string[];
  };
  return { status: data.status, images: data.images, refGap: data.ref_gap ?? [] };
}

/** 资产设定图生成：复用批量出图任务通道，按资产类型定幅面与布局；
 *  params 透传卡片级出图覆盖（data.gen 的 model/resolution/aspect），
 *  aspect 显式画幅覆写（空=按类型默认幅面） */
export async function startCharacterImageJob(opts: {
  rid: string;
  name: string;
  description: string;
  assetType?: "character" | "scene" | "prop" | "costume";
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

// ---------- 分镜行批量出视频（BigModel CogVideoX 直连，同出图 job 范式） ----------

/** 出视频请求：prompt = 运动描述（运镜+画面动态+图N 参考编号，必填——视频
 *  提示词描述「怎么动」而非重复首帧图已有的静态画面）；imageUrl = 首帧图
 *  （镜头图卡主图，占参考槽 0）；referenceImages = 参考图清单（行引用的
 *  资产设定图等，最多 8 张）；params 镜头级覆盖（时长/清晰度/画幅） */
export type ShotVideoRequest = {
  rid: string;
  name: string;
  prompt: string;
  /** 首帧图（本服务资产 URL） */
  imageUrl?: string;
  /** 参考图（资产设定图 URL，上限 8——超出 agent 截断） */
  referenceImages?: string[];
  params?: VideogenParams;
};

export type ShotVideoResult = {
  rid: string;
  ok: boolean;
  videoUrl?: string;
  error?: string;
};

export class VideoJobGoneError extends Error {}

/** 轮询批量出视频任务：每条完成即回调 onItem（同 pollShotImageJob 的
 *  无进展空转口径，窗口放宽到 15 分钟——视频单条比出图慢得多） */
export async function pollShotVideoJob(
  jobId: string,
  onItem: (item: ShotVideoResult) => void,
  stallMs = 15 * 60 * 1000,
): Promise<"done" | "timeout" | "gone" | "cancelled"> {
  let stallDeadline = Date.now() + stallMs;
  const applied = new Set<string>();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let job;
    try {
      job = await getShotVideoJob(jobId);
    } catch (exc) {
      if (exc instanceof VideoJobGoneError) return "gone";
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

/** 启动批量出视频任务（Next 代理掐长请求，异步 job + 轮询）。服务端按
 *  models.py 视频目录逐镜头校验时长/清晰度/画幅组合，非法 400 点名 */
export async function startShotVideoJob(
  shots: ShotVideoRequest[],
  params?: VideogenParams,
): Promise<string> {
  const r = await apiFetch("/agent-service/storyboard/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shots,
      ...(params?.model ? { params } : {}),
      project_id: useCanvasStore.getState().projectId,
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 160);
    throw new Error(detail || `批量出视频启动失败（${r.status}）`);
  }
  const data = (await r.json()) as { jobId?: string };
  if (!data.jobId) throw new Error("批量出视频任务启动失败");
  return data.jobId;
}

export async function cancelShotVideoJob(jobId: string): Promise<boolean> {
  const r = await apiFetch(`/agent-service/storyboard/videos/${jobId}`, {
    method: "DELETE",
  });
  return r.ok;
}

export async function getShotVideoJob(jobId: string): Promise<{
  status: "running" | "done" | "cancelled";
  images: ShotVideoResult[];
}> {
  const r = await apiFetch(`/agent-service/storyboard/videos/${jobId}`);
  if (r.status === 404) throw new VideoJobGoneError("出视频任务不存在（agent 可能已重启）");
  if (!r.ok) throw new Error(`出视频任务查询失败（${r.status}）`);
  return (await r.json()) as {
    status: "running" | "done" | "cancelled";
    images: ShotVideoResult[];
  };
}
