/** 多模态参考分解图数量（Seedance 参考模式建议 4-6，上限 9；拼图整图模式可为 1 张） */
export const VIDEO_REFERENCE_FRAME_COUNT = {
  min: 4,
  recommended: 5,
  max: 6,
  /** 一张多分格拼图直接作为参考时，最少 1 张 */
  sheetMin: 1,
} as const
