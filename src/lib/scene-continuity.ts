/**
 * 镜间身体状态接力：分镜 LLM 必须输出可核对的 startState / endState
 */

export type ScenePhysicalState = {
  startState?: string
  endState?: string
  continuity?: string
}

/** 写入 metadata 的状态字段（过滤空串） */
export function buildStateMetadataFields(
  scene: ScenePhysicalState
): Record<string, string> {
  const out: Record<string, string> = {}
  if (scene.startState?.trim()) out.startState = scene.startState.trim()
  if (scene.endState?.trim()) out.endState = scene.endState.trim()
  if (scene.continuity?.trim()) out.continuity = scene.continuity.trim()
  return out
}

export function readStateFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): ScenePhysicalState {
  if (!metadata) return {}
  return {
    startState:
      typeof metadata.startState === 'string' ? metadata.startState : undefined,
    endState:
      typeof metadata.endState === 'string' ? metadata.endState : undefined,
    continuity:
      typeof metadata.continuity === 'string' ? metadata.continuity : undefined,
  }
}

/** 供拼图/视频提示词拼接 */
export function formatStateForPrompt(state: ScenePhysicalState): string {
  const parts = [
    state.startState ? `开场状态：${state.startState}` : '',
    state.endState ? `收束状态：${state.endState}` : '',
    state.continuity ? `镜间衔接：${state.continuity}` : '',
  ].filter(Boolean)
  return parts.join('；')
}

/**
 * 动作编排：强制招式级描写（挥/劈/砍/刺等），禁止空泛「攻击」
 */
export const SCENE_ACTION_CHOREOGRAPHY_RULES = `
### 动作编排描写（必须遵守，与状态接力同等重要）
\`action\` 与 \`description\` 必须写清**可见的招式、轨迹与发力**，禁止只写意图或结果。

**禁止（空泛，不可拍）：**
- 攻击、动手、交手、对峙、交锋、出招、挥剑、拔剑、砍过去、打出去、激烈打斗
- 「表情复杂」「若有所思」「气势逼人」等不可直接入镜的词

**必须写成招式级动词（按戏选）：**
- 剑/刀：斜劈、直劈、下砍、横扫、上撩、直刺、点刺、崩剑、格挡、磕开、回抽、绞剑、抹喉式横斩
- 拳脚：直拳、摆拳、肘击、膝撞、侧踹、扫腿、弓步前冲、后撤步
- 通用：蓄力、发力、收势、震开、卸力、错身、闪让

**有肢体冲突或武器戏的分镜，\`action\` 至少写清 5 点（可并入起态→过程→终态）：**
1. **招式核**：具体招式名/动作（如「自右肩向左下斜劈」）
2. **轨迹方向**：从哪到哪，相对身体或对手的方位
3. **发力节奏**：蓄力→爆发→随势/收势
4. **身体联动**：蹬地、转腰、肩肘腕传导、重心前后
5. **器械/肢体落点**：剑锋朝向、刃面、掠过/命中何处；另一只手在做什么

**篇幅：** 动作戏 \`action\` 建议 60-140 字；纯对话/空镜可短，但仍要有具体可见小动作。

**反例：** action="挥剑攻击敌人"
**正例：** action="起：右弓步，右手正握剑举至右耳侧，剑尖斜朝后上方蓄力→过程：左脚蹬地转腰，剑自右上向左下斜劈，刃锋掠过胸前一线，衣袖甩出弧线→终：剑势落至左前方低位，右腕微外旋收势，重心仍压在右腿"

**description 同步：** 画面描述里也要用一两句写出同一招式的可见瞬间（不是只写风景），方便后续拼图/视频对齐。
`.trim()

/**
 * 注入到各分析/分镜 LLM 的系统规则
 */
export const SCENE_STATE_CONTINUITY_RULES = `
### 镜间身体状态接力（必须遵守，最高优先级）
每个分镜必须输出 \`startState\` / \`endState\`，并在 \`action\` 中写清「起态→过程→终态」。

**startState / endState 必须可核对，禁止空泛动词：**
- 身体姿态：站定 / 冲刺中 / 弓步 / 半蹲 等
- 朝向与重心落点
- 持物：哪只手、正握/反握/双手、出鞘或举起进度（可用约 0% / 30% / 半剑 / 出鞘完毕）
- 另一只手位置与视线方向

**接力硬约束：**
- 第 N 镜 \`endState\` ≡ 第 N+1 镜 \`startState\`（措辞可微调，物理状态必须一致）
- 禁止无交代地从「右手反握、冲刺中拔剑」跳成「站定、正手拔剑」
- \`continuity\` 写清本镜相对上一镜的差异与过渡（出鞘进度变化、步伐变化），不要只写「硬切」
- \`action\` 第一句必须承接上一镜收束状态，再写本镜过程与终态（过程段必须含招式级动作，见「动作编排描写」）

反例（禁止）：action="拔剑"；startState="准备拔剑"
正例：startState="身体前冲未停，右手反握剑柄，剑身出鞘约30%，左手扶鞘"；endState="右弓步定住，右手正握剑举至右肩上方，剑尖斜朝后上，蓄势待劈"；action="起：冲刺中右手反握出鞘约30%→过程：抽剑至尽，翻腕改为正握举至右肩蓄力→终：弓步举剑于右肩，剑尖斜后上，下一拍可斜劈"
`.trim()

/** JSON schema 片段说明（嵌入各输出格式） */
export const SCENE_STATE_JSON_FIELDS = `
      "action": "起态→过程→终态；过程必须含招式级动作（斜劈/直刺/横扫等）与轨迹发力，禁止只写攻击/挥剑",
      "startState": "本镜开场身体与持物状态（必须=上一镜 endState）",
      "endState": "本镜收束身体与持物状态（供下一镜 startState 接力）",
      "continuity": "与上一镜的衔接方式（具体过渡，禁止只写硬切）",
      "durationSec": "本镜最优视频时长（秒，数字，默认 4 或 5，通常 4-5，硬上限 12）",
`.trim()

/**
 * 分镜最优时长：默认 4–5 秒，装不下就拆镜，不要拉长
 */
export const SCENE_DURATION_RULES = `
### 分镜最优时长（必须遵守）
每个分镜必须输出 \`durationSec\`（秒，整数），并按内容算出**最优生成时长**。

**目标区间：4–5 秒（首选）**
- 常规动作拍、反应镜、短对白、空镜定场：优先 **4** 或 **5**
- 只有装不下时才允许 6–8；**超过 8 必须拆成多个分镜**，不要用拉长时长硬塞
- 硬上限 12 秒（Seedance 限制）；禁止输出 >12

**估算方法（写入 durationSec 前自检）：**
1. 对白：约 0.3 秒/字 + 0.5–1 秒画面呼吸；单镜台词宜短（约 8–15 字），过长拆镜
2. 招式动作：一个清晰招式（蓄力→发力→收势）通常 **4–5** 秒；连续两招以上拆镜
3. 纯空镜/表情：默认 **4** 秒
4. 内容装不进 5 秒 → **拆镜**，而不是写成 8–12 秒一镜到底

**与内容匹配：**
- durationSec=4：单拍动作或极短反应
- durationSec=5：标准一镜一事（默认优选）
- durationSec≥6：仅当确有必要，并在 continuity/action 里写清为何不能拆

反例：把「冲刺+拔剑+斜劈+收势」塞进 10 秒一镜
正例：拆成 镜A 冲刺拔剑蓄力(5s) → 镜B 斜劈收势(4s)，各写 durationSec
`.trim()

/** 规范化 LLM 给出的时长（秒） */
export function normalizeSceneDurationSec(raw: unknown, fallback = 5): number {
  let n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? parseFloat(raw)
        : NaN
  if (!Number.isFinite(n)) n = fallback
  // 若给的是毫秒
  if (n > 100) n = Math.round(n / 1000)
  n = Math.round(n)
  return Math.min(12, Math.max(4, n))
}

export function buildDurationMetadataFields(durationSec?: unknown): {
  duration?: number
} {
  if (durationSec === undefined || durationSec === null || durationSec === '') {
    return {}
  }
  return { duration: normalizeSceneDurationSec(durationSec) }
}
