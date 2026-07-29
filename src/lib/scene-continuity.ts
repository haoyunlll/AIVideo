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
- \`action\` 第一句必须承接上一镜收束状态，再写本镜过程与终态

反例（禁止）：action="拔剑"；startState="准备拔剑"
正例：startState="身体前冲未停，右手反握剑柄，剑身出鞘约30%，左手扶鞘"；endState="仍在前冲，右手反握，剑已出鞘约70%，剑锋斜向前上方"；action="起：冲刺中右手反握出鞘约30%→过程：继续前冲反握抽剑→终：出鞘约70%"
`.trim()

/** JSON schema 片段说明（嵌入各输出格式） */
export const SCENE_STATE_JSON_FIELDS = `
      "action": "起态→过程→终态的动作描写（必须含握姿/进度等可核对细节）",
      "startState": "本镜开场身体与持物状态（必须=上一镜 endState）",
      "endState": "本镜收束身体与持物状态（供下一镜 startState 接力）",
      "continuity": "与上一镜的衔接方式（具体过渡，禁止只写硬切）",
`.trim()
