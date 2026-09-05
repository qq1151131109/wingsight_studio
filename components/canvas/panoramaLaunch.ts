"use client";

/**
 * 全景环视一键启动（v13 去确认弹窗——弹窗里唯一可交互的是可选补充要求，
 * 其余全是说明文字，用户裁决没必要）：预校验模型目录（2:1 只有 seedream 系，
 * 目录无可用模型/加载失败 toast 明报不吐内部 id）→ 建全景新卡（panorama 标记
 * + gen 钉 2:1）→ 连线 → 对新卡发 GENERATE_EVENT（原图作参考，不覆盖源卡）。
 * 环视工具条按钮 / 右键菜单 / 卡面入口共用。
 */
import { loadImageModels } from "@/lib/imagegen";
import {
  NODE_FOOTPRINT,
  absolutePosition,
  useCanvasStore,
} from "@/lib/canvas/store";
import { GENERATE_EVENT, type GenerateDetail } from "@/lib/canvas/events";
import { showToast } from "@/lib/toast";

/** 全景职责化模板 v3（doc/image-panorama-spec.md §2.3 + §4 探针矩阵）：
 *  参考图角色句防拉伸 + 几何约束 + 竞品 open-storyboard 否定句全集 + 探针
 *  v2 验证有效的鱼眼/圆框/暗角禁令。注意：在售模型画不出严格等距柱状几何
 *  （五组探针结论），本模板职责是防鱼眼圆框/单视角横幅/参考图硬拉伸，
 *  接缝连续性由 PanoramaViewer 的 crop+羽化矫形兜底（竞品同款分工）。 */
const PANO_PROMPT =
  "把参考图作为场景参考，生成一张完整的 360 度球形全景环境图：参考图只提供" +
  "主体、材质、色彩、构图线索与风格，四周缺失的环境（左右后方、天空与地面）" +
  "由你补全，不要简单拉伸或变形参考图。最终图片必须是等距柱状投影的完整球形" +
  "全景，比例2比1（宽度是高度的2倍），只输出一张连续画面：水平方向覆盖完整" +
  "360度，垂直方向覆盖从天空到地面的完整180度，观看者位于场景中心可以环视" +
  "四周，地平线位于画面垂直中心附近，左右边缘内容自然衔接，像展开的世界地图" +
  "一样横向铺满整个画幅。画面中所有垂直线条（柱子、墙壁边缘、树木）保持垂直" +
  "不倾斜不汇聚，地面向左右水平延展不向中心汇聚。禁止：鱼眼镜头效果、圆形或" +
  "球面边框、桶形畸变、暗角；普通单视角照片、横幅照片、电影宽银幕截图；把全景" +
  "画成一个球、一个圆窗或一个门洞；分屏拼贴、多宫格、画中画；摄影师、相机、" +
  "三脚架等拍摄设备；文字、水印、边框、明显接缝。";

export async function launchPanorama(nodeId: string): Promise<void> {
  const st = useCanvasStore.getState();
  const node = st.nodes.find((n) => n.id === nodeId);
  const d = node?.data;
  if (!node || !d?.imageUrl) return;

  // 模型预校验（doc/image-panorama-spec.md §2.4）：2:1 画幅只有 seedream 系；
  // 项目默认模型可用则跟随，否则预置目录第一个可用模型
  let chosen: { model: string; resolution: string };
  try {
    const ms = await loadImageModels();
    const capable = ms.filter((m) => (m.aspects ?? []).includes("2:1"));
    if (capable.length === 0) {
      showToast("模型目录没有支持 2:1 全景的模型，请在底坞「出图」里检查");
      return;
    }
    const pick = capable.find((m) => m.id === st.imagegen.model) ?? capable[0];
    chosen = {
      model: pick.id,
      resolution: pick.resolutions.includes("2K")
        ? "2K"
        : pick.default_resolution,
    };
  } catch {
    showToast("模型目录加载失败，请到底坞「出图」重试");
    return;
  }

  const srcText =
    String(d.genPrompt ?? "").trim() || String(d.body ?? "").trim();
  const prompt = PANO_PROMPT + (srcText ? `\n参考画面内容：${srcText}` : "");
  const abs = absolutePosition(st.nodes, node);
  const nw = node.measured?.width ?? NODE_FOOTPRINT.image.w;
  const newId = st.addNode({
    position: { x: abs.x + nw + 80, y: abs.y },
    data: {
      nodeType: "image",
      title: `${d.title || "图片"} · 全景`,
      body: prompt,
      // panorama 标记挂灯箱环视查看器 + 完成自动弹 3D；gen 显式钉 2:1 防
      // resolveAutoAspect 吸附参考比例
      panorama: true,
      gen: { model: chosen.model, resolution: chosen.resolution, aspect: "2:1" },
    },
  });
  st.connect({ source: nodeId, target: newId });
  st.flashNodes([newId]);
  // 对新卡发事件（铁律：对源卡发是原位生成会覆盖源图）；源图经 refIds + 连线
  // 双通道进参考序列
  window.dispatchEvent(
    new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
      detail: { nodeId: newId, kind: "image", prompt, refIds: [nodeId] },
    }),
  );
}
