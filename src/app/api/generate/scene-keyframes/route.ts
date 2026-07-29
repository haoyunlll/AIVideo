import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { generateImage, invokeLLM } from '@/lib/ai'
import { getSupabaseClient, isDatabaseConfigured } from '@/storage/database/supabase-client'
import { memoryScenes, memoryProjects, memoryCharacters } from '@/lib/memory-storage'
import { getStylePrompt } from '@/lib/styles'
import { uploadFile } from '@/lib/storage'
import { VIDEO_REFERENCE_FRAME_COUNT } from '@/lib/video-reference'
import { readStateFromMetadata } from '@/lib/scene-continuity'

export const maxDuration = 300

/** 单格补生成时的通用节拍（中间过渡） */
const KEYFRAME_BEATS = [
  '开场定场：交代空间与人物初始站位，动作尚未展开',
  '推进起势：人物开始移动或蓄力，镜头跟随主体',
  '冲突爆发：关键动作/打击/对峙发生，有明显动态与反馈',
  '局势转折：反击、失控或高潮瞬间，情绪最强',
  '收束定格：结果落定（胜负/溃败/停顿），画面可作收尾',
  '余韵空镜：尘埃落定后的余波或定场空镜',
]

function getStoryboardGrid(frameCount: number): { cols: number; rows: number } {
  if (frameCount <= 4) return { cols: 2, rows: 2 }
  // 5 或 6：3 列 2 行（5 张时最后一格留白，裁切时跳过）
  return { cols: 3, rows: 2 }
}

function pickImageUrl(result: { urls: string[]; b64List?: string[] }): string {
  return (
    result.urls[0] ||
    (result.b64List?.[0] ? `data:image/png;base64,${result.b64List[0]}` : '')
  )
}

function toPublicImageUrl(keyOrUrl: string): string {
  if (keyOrUrl.startsWith('http') || keyOrUrl.startsWith('data:')) return keyOrUrl
  const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT || 'http://127.0.0.1:5000'
  return `${domain}/api/images?key=${encodeURIComponent(keyOrUrl)}`
}

type SceneCharacter = {
  id: string
  name: string
  appearance: string
  imageUrl?: string
}

type SceneContext = {
  description: string
  action: string
  emotion: string
  dialogue: string
  stylePrompt: string
  characters: SceneCharacter[]
  startState?: string
  endState?: string
  continuity?: string
}

function characterPromptLine(characters: SceneCharacter[]): string {
  if (!characters.length) return ''
  return (
    '画面角色必须与下列设定一致（长相/发型/服装勿换脸）：' +
    characters
      .map((c) => `${c.name}${c.appearance ? `（${c.appearance}）` : ''}`)
      .join('；')
  )
}

/**
 * 读取分镜关联角色（项目人物；人物库需先导入到项目并挂到分镜）
 */
async function resolveSceneCharacters(
  sceneId: string,
  characterIdsHint?: string[]
): Promise<SceneCharacter[]> {
  let characterIds = [...(characterIdsHint || [])]

  const memScene = memoryScenes.find((s) => s.id === sceneId)
  if (memScene?.characterIds?.length && characterIds.length === 0) {
    characterIds = [...memScene.characterIds]
  }

  if (isDatabaseConfigured()) {
    const supabase = getSupabaseClient()
    if (characterIds.length === 0) {
      const { data: scene } = await supabase
        .from('scenes')
        .select('character_ids')
        .eq('id', sceneId)
        .maybeSingle()
      if (Array.isArray(scene?.character_ids)) {
        characterIds = scene.character_ids.filter((id: unknown) => typeof id === 'string')
      }
    }
  }

  if (characterIds.length === 0) return []

  const results: SceneCharacter[] = []

  for (const id of characterIds) {
    const mem = memoryCharacters.find((c) => c.id === id)
    let name = mem?.name || ''
    let appearance = mem?.appearance || ''
    let imageUrl: string | undefined

    const memKey = mem?.frontViewKey || mem?.imageUrl
    if (memKey) imageUrl = toPublicImageUrl(memKey)

    if (isDatabaseConfigured()) {
      const { data } = await getSupabaseClient()
        .from('characters')
        .select('name, appearance, front_view_key, image_url')
        .eq('id', id)
        .maybeSingle()

      if (data) {
        name = data.name || name
        appearance = data.appearance || appearance
        const key = data.front_view_key || data.image_url
        if (key && typeof key === 'string') {
          imageUrl = toPublicImageUrl(key)
        }
      }
    }

    if (!name && !appearance && !imageUrl) continue
    results.push({
      id,
      name: name || '角色',
      appearance,
      imageUrl,
    })
  }

  return results
}

/**
 * 用 LLM 根据剧情写出各格更细致的故事流说明（含首帧/尾帧叙事锚点）；失败则回退模板
 * 只用于拼提示词，不单独出图
 */
async function planStoryFlowPanels(
  ctx: SceneContext,
  frameCount: number
): Promise<string[]> {
  const fallback = Array.from({ length: frameCount }, (_, i) => {
    if (i === 0) {
      return `首帧定场：${ctx.startState || ctx.description.slice(0, 80)}；动作起点姿态锁定`
    }
    if (i === frameCount - 1) {
      return `尾帧收束：${ctx.endState || ctx.action || ctx.description.slice(0, 60)}；结果落定`
    }
    const beat = KEYFRAME_BEATS[Math.min(i, KEYFRAME_BEATS.length - 1)]
    return `故事推进 ${i}/${frameCount - 1}：${beat}；结合剧情「${(ctx.action || ctx.description).slice(0, 60)}」`
  })

  try {
    const raw = await invokeLLM(
      [
        {
          role: 'system',
          content: `你是分镜师。根据一个短剧分镜的剧情，输出 ${frameCount} 格「故事流」画面说明。
规则：
1. 第1格必须严格等于开场状态 startState（身体姿态、握姿、出鞘进度、朝向），禁止改成正握/站定等另一种状态
2. 最后一格必须严格等于收束状态 endState
3. 中间格按时间顺序从 startState 推进到 endState，每格只写一个清晰瞬间，握姿与持物不得无故切换
4. 每格 30-60 字，写清：谁在哪、姿态/持物细节、镜头感（景别/朝向可简写）
5. 若提供了角色列表，出场角色名称必须与列表一致，不要擅自增减角色
6. 严格输出 JSON 数组字符串，长度必须为 ${frameCount}，不要 markdown，不要其它文字`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            style: ctx.stylePrompt,
            description: ctx.description,
            action: ctx.action || null,
            startState: ctx.startState || null,
            endState: ctx.endState || null,
            continuity: ctx.continuity || null,
            emotion: ctx.emotion || null,
            dialogue: ctx.dialogue || null,
            characters: ctx.characters.map((c) => ({
              name: c.name,
              appearance: c.appearance || null,
            })),
            frameCount,
          }),
        },
      ],
      { temperature: 0.6 }
    )

    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
    const parsed = JSON.parse(cleaned) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.length === frameCount &&
      parsed.every((x) => typeof x === 'string' && x.trim())
    ) {
      return parsed.map((s) => String(s).trim())
    }
  } catch (err) {
    console.warn('[Scene Keyframes] LLM story-flow plan failed, use fallback:', err)
  }

  return fallback
}

/** 最终拼图提示词：第1格=首帧、最后格=尾帧，中间为故事流（只出这一张图） */
function buildSheetPrompt(
  ctx: SceneContext,
  frameCount: number,
  panelStories: string[]
): string {
  const { cols, rows } = getStoryboardGrid(frameCount)
  const panelSpecs = panelStories
    .map((story, i) => {
      const ts = `0:0${i}`
      const role =
        i === 0 ? '【首帧】' : i === frameCount - 1 ? '【尾帧】' : `【故事流第${i + 1}拍】`
      return `第${i + 1}格(左上角时间戳 ${ts})${role}：${story}`
    })
    .join('；')

  const emptyHint =
    cols * rows > frameCount
      ? `网格共 ${cols}×${rows}=${cols * rows} 格，仅填充前 ${frameCount} 格为有效画面，多余格保持纯白空白`
      : ''

  const hasRefs = ctx.characters.some((c) => c.imageUrl)

  return [
    ctx.stylePrompt,
    `一张完整的动作/剧情分解分镜拼图（storyboard comic strip），类似游戏关键帧或动画分镜表`,
    `单张图片内含 ${cols} 列 × ${rows} 行整齐网格`,
    '白色细线分隔各格，每格独立完整画面，按时间顺序从左到右、从上到下阅读',
    '构思顺序：第1格锁定开场状态，最后格锁定收束状态，中间从起态推进到终态；握姿/出鞘进度不得无故切换',
    '第1格必须是「首帧」= startState，最后一有效格必须是「尾帧」= endState；中间格按故事因果连续推进，同一角色外观高度一致',
    characterPromptLine(ctx.characters),
    hasRefs
      ? '若提供了角色参考图，各格人物长相与服装必须与参考图高度一致，禁止换脸或另造新角色'
      : '',
    panelSpecs,
    emptyHint,
    `分镜剧情：${ctx.description}`,
    ctx.action ? `核心动作：${ctx.action}` : '',
    ctx.startState ? `开场状态（第1格必须一致）：${ctx.startState}` : '',
    ctx.endState ? `收束状态（末格必须一致）：${ctx.endState}` : '',
    ctx.continuity ? `镜间衔接：${ctx.continuity}` : '',
    ctx.emotion ? `情绪主线：${ctx.emotion}` : '',
    ctx.dialogue ? `对白/旁白线索：${ctx.dialogue}` : '',
    '中间格要比笼统节拍更细：写出因果、肢体反馈、视线与构图变化，形成可读的故事流',
    '不要把整页做成一张大图，必须是清晰分格；不要真实照片人脸',
    '4K，细节丰富，构图对齐整齐',
  ]
    .filter(Boolean)
    .join('，')
}

async function storePng(
  sceneId: string,
  buffer: Buffer,
  filenamePrefix: string
): Promise<{ url: string; key: string }> {
  const key = `scenes/${sceneId}/keyframes/${filenamePrefix}_${Date.now()}.png`
  let storedUrl: string
  try {
    storedUrl = await uploadFile(key, buffer, 'image/png')
  } catch (uploadErr) {
    console.warn('[Scene Keyframes] upload failed, save local', uploadErr)
    const fs = await import('fs')
    const path = await import('path')
    const dir = path.join(process.cwd(), 'public', 'scenes', sceneId, 'keyframes')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const filename = `${filenamePrefix}_${Date.now()}.png`
    fs.writeFileSync(path.join(dir, filename), buffer)
    storedUrl = `/scenes/${sceneId}/keyframes/${filename}`
  }

  const displayUrl = storedUrl.startsWith('/')
    ? storedUrl
    : `/api/images?key=${encodeURIComponent(key)}`

  return { url: displayUrl, key }
}

/** 把拼图 URL 写入分镜 metadata，供下一镜衔接 */
async function persistSceneReferenceSheet(
  sceneId: string,
  sheetUrl: string,
  sheetKey: string,
  frameCount: number
): Promise<void> {
  const patch = {
    referenceSheetUrl: sheetUrl,
    referenceSheetKey: sheetKey,
    referenceFrameCount: frameCount,
  }

  const memIdx = memoryScenes.findIndex((s) => s.id === sceneId)
  if (memIdx !== -1) {
    memoryScenes[memIdx].metadata = {
      ...(memoryScenes[memIdx].metadata || {}),
      ...patch,
    }
  }

  if (isDatabaseConfigured()) {
    try {
      const supabase = getSupabaseClient()
      const { data: existing } = await supabase
        .from('scenes')
        .select('metadata')
        .eq('id', sceneId)
        .maybeSingle()
      const nextMeta = {
        ...((existing?.metadata as Record<string, unknown>) || {}),
        ...patch,
      }
      await supabase
        .from('scenes')
        .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
        .eq('id', sceneId)
    } catch (err) {
      console.warn('[Scene Keyframes] persist sheet metadata failed:', err)
    }
  }
}

/**
 * 将一张分镜拼图按网格裁成多张关键帧
 */
async function splitStoryboardSheet(
  sheetBuffer: Buffer,
  frameCount: number
): Promise<Buffer[]> {
  const { cols, rows } = getStoryboardGrid(frameCount)
  const meta = await sharp(sheetBuffer).metadata()
  const width = meta.width || 0
  const height = meta.height || 0
  if (!width || !height) {
    throw new Error('无法读取拼图尺寸')
  }

  // 略向内收缩，避开白色分隔线
  const insetX = Math.max(2, Math.floor(width / cols / 40))
  const insetY = Math.max(2, Math.floor(height / rows / 40))
  const cellW = Math.floor(width / cols)
  const cellH = Math.floor(height / rows)

  const panels: Buffer[] = []
  for (let i = 0; i < frameCount; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const left = col * cellW + insetX
    const top = row * cellH + insetY
    const extractW = Math.max(1, cellW - insetX * 2)
    const extractH = Math.max(1, cellH - insetY * 2)

    const panel = await sharp(sheetBuffer)
      .extract({
        left: Math.min(left, width - extractW),
        top: Math.min(top, height - extractH),
        width: extractW,
        height: extractH,
      })
      .png()
      .toBuffer()
    panels.push(panel)
  }
  return panels
}

/**
 * POST /api/generate/scene-keyframes
 * - 一键生成：LLM 规划故事流（含首尾叙事）→ 只生成一张多分格拼图
 * - 单格生成：仍生成单幅关键帧
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      sceneId,
      count = VIDEO_REFERENCE_FRAME_COUNT.recommended,
      index, // 若指定，仅生成第 index 张（0-based）
      mode, // 'sheet' | 'single'，默认一键为 sheet
      split = true, // 是否把拼图裁成多格；整图直传时可 false
    } = body as {
      sceneId?: string
      count?: number
      index?: number
      mode?: 'sheet' | 'single'
      split?: boolean
    }

    if (!sceneId) {
      return NextResponse.json({ error: '缺少 sceneId' }, { status: 400 })
    }

    const frameCount = Math.min(
      VIDEO_REFERENCE_FRAME_COUNT.max,
      Math.max(
        VIDEO_REFERENCE_FRAME_COUNT.min,
        Number(count) || VIDEO_REFERENCE_FRAME_COUNT.recommended
      )
    )

    let description = ''
    let emotion = ''
    let action = ''
    let dialogue = ''
    let style = 'realistic_cinema'
    let customStylePrompt = ''
    let projectId = ''
    let startState = ''
    let endState = ''
    let continuity = ''

    const memScene = memoryScenes.find((s) => s.id === sceneId)
    if (memScene) {
      description = memScene.description || ''
      emotion = memScene.emotion || ''
      action = memScene.action || ''
      dialogue = memScene.dialogue || ''
      projectId = memScene.projectId
      const memState = readStateFromMetadata(memScene.metadata)
      startState = memState.startState || ''
      endState = memState.endState || ''
      continuity = memState.continuity || ''
      const project = memoryProjects.find((p) => p.id === projectId)
      if (project?.style) style = project.style
      if (project?.customStylePrompt) customStylePrompt = project.customStylePrompt
    }

    if (isDatabaseConfigured()) {
      const supabase = getSupabaseClient()
      const { data: scene } = await supabase
        .from('scenes')
        .select('description, emotion, action, dialogue, project_id, metadata')
        .eq('id', sceneId)
        .maybeSingle()

      if (scene) {
        description = scene.description || description
        emotion = scene.emotion || emotion
        action = scene.action || action
        dialogue = scene.dialogue || dialogue
        projectId = scene.project_id || projectId
        const dbState = readStateFromMetadata(
          scene.metadata as Record<string, unknown> | null
        )
        startState = dbState.startState || startState
        endState = dbState.endState || endState
        continuity = dbState.continuity || continuity

        if (projectId) {
          const { data: project } = await supabase
            .from('projects')
            .select('style, custom_style_prompt')
            .eq('id', projectId)
            .maybeSingle()
          if (project?.style) style = project.style
          if (project?.custom_style_prompt) customStylePrompt = project.custom_style_prompt
        }
      }
    }

    if (!description) {
      return NextResponse.json({ error: '分镜缺少描述，无法生成分解图' }, { status: 400 })
    }

    const stylePrompt =
      style === 'custom' && customStylePrompt ? customStylePrompt : getStylePrompt(style)

    const characters = await resolveSceneCharacters(sceneId)
    console.log(
      '[Scene Keyframes] characters:',
      characters.map((c) => ({ name: c.name, hasImage: !!c.imageUrl, appearance: c.appearance?.slice(0, 40) }))
    )

    const ctx: SceneContext = {
      description,
      action,
      emotion,
      dialogue,
      stylePrompt,
      characters,
      startState: startState || undefined,
      endState: endState || undefined,
      continuity: continuity || undefined,
    }

    const characterRefImages = characters
      .map((c) => c.imageUrl)
      .filter((u): u is string => !!u)

    const { downloadFile } = await import('@/lib/utils')
    const generateAll =
      typeof index !== 'number' || index < 0 || index >= frameCount
    const useSheet = generateAll && mode !== 'single'

    // ---------- 一键：规划故事流 → 只出一张拼图 ----------
    if (useSheet) {
      const panelStories = await planStoryFlowPanels(ctx, frameCount)
      const sheetPrompt = buildSheetPrompt(ctx, frameCount, panelStories)
      console.log('[Scene Keyframes] sheet prompt:', sheetPrompt.slice(0, 220))
      console.log('[Scene Keyframes] panel stories:', panelStories)
      console.log('[Scene Keyframes] character refs:', characterRefImages.length)

      const sheetResult = await generateImage(sheetPrompt, {
        size: '2K',
        watermark: false,
        image: characterRefImages.length > 0 ? characterRefImages : undefined,
      })
      const sheetUrl = pickImageUrl(sheetResult)
      if (!sheetUrl) throw new Error('分镜拼图生成失败')

      const sheetBuffer = await downloadFile(sheetUrl)
      const sheetStored = await storePng(sceneId, sheetBuffer, 'sheet')

      // 持久化拼图地址，供下一镜视频衔接使用
      await persistSceneReferenceSheet(sceneId, sheetStored.url, sheetStored.key, frameCount)

      if (split === false) {
        return NextResponse.json({
          success: true,
          sceneId,
          frameCount,
          mode: 'sheet',
          sheetUrl: sheetStored.url,
          sheetKey: sheetStored.key,
          panelStories,
          characterCount: characters.length,
          keyframes: [],
        })
      }

      const panels = await splitStoryboardSheet(sheetBuffer, frameCount)
      const results: { index: number; url: string; key: string; beat: string }[] = []
      for (let i = 0; i < panels.length; i++) {
        const stored = await storePng(sceneId, panels[i], `kf_${i + 1}`)
        results.push({
          index: i,
          url: stored.url,
          key: stored.key,
          beat: panelStories[i] || KEYFRAME_BEATS[Math.min(i, KEYFRAME_BEATS.length - 1)],
        })
      }

      return NextResponse.json({
        success: true,
        sceneId,
        frameCount,
        mode: 'sheet',
        sheetUrl: sheetStored.url,
        sheetKey: sheetStored.key,
        panelStories,
        characterCount: characters.length,
        keyframes: results,
      })
    }

    // ---------- 单格 / 旧模式：逐张生成 ----------
    const indices =
      typeof index === 'number' && index >= 0 && index < frameCount
        ? [index]
        : Array.from({ length: frameCount }, (_, i) => i)

    const results: { index: number; url: string; key: string; beat: string }[] = []

    for (const i of indices) {
      const beat = KEYFRAME_BEATS[Math.min(i, KEYFRAME_BEATS.length - 1)]
      const prompt = [
        stylePrompt,
        `分镜连续动作分解关键帧 ${i + 1}/${frameCount}`,
        `时间点约 ${i} 秒位置，左上角可带时间戳 0:0${i}`,
        `画面节拍：${beat}`,
        `场景内容：${description}`,
        action ? `动作：${action}` : '',
        emotion ? `情绪氛围：${emotion}` : '',
        characterPromptLine(characters),
        characterRefImages.length > 0
          ? '人物长相服装必须与角色参考图一致，禁止换脸'
          : '',
        '同一场景、同一角色外观保持一致，清晰关键帧，单幅完整画面（不是多分格拼图）',
        '非真人照片，非写实摄影',
        '4K，细节丰富',
      ]
        .filter(Boolean)
        .join('，')

      console.log(`[Scene Keyframes] Generating single ${i + 1}/${frameCount}:`, prompt.slice(0, 120))

      const imageResult = await generateImage(prompt, {
        size: '2K',
        watermark: false,
        image: characterRefImages.length > 0 ? characterRefImages : undefined,
      })
      const imageUrl = pickImageUrl(imageResult)
      if (!imageUrl) {
        throw new Error(`第 ${i + 1} 张分解图生成失败`)
      }

      const buffer = await downloadFile(imageUrl)
      const stored = await storePng(sceneId, buffer, `kf_${i + 1}`)
      results.push({
        index: i,
        url: stored.url,
        key: stored.key,
        beat,
      })
    }

    results.sort((a, b) => a.index - b.index)

    return NextResponse.json({
      success: true,
      sceneId,
      frameCount,
      mode: 'single',
      keyframes: results,
    })
  } catch (error) {
    console.error('[Scene Keyframes] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '分解图生成失败' },
      { status: 500 }
    )
  }
}
