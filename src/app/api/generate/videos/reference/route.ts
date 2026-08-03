import { NextRequest, NextResponse } from 'next/server'
import {
  generateVideoFromReferenceImages,
  DEFAULT_VIDEO_MODEL,
} from '@/lib/ai'
import { VIDEO_REFERENCE_FRAME_COUNT } from '@/lib/video-reference'
import { getSupabaseClient, isDatabaseConfigured } from '@/storage/database/supabase-client'
import { memoryScenes, memoryProjects, memoryCharacters } from '@/lib/memory-storage'
import { getVideoStylePrompt } from '@/lib/styles'
import { uploadFile, extractStorageKeyFromUrl } from '@/lib/storage'
import { readStateFromMetadata } from '@/lib/scene-continuity'
import {
  createPreviousSceneTailClip,
  CONTINUITY_TAIL_SECONDS,
} from '@/lib/video-tail-clip'
import * as fs from 'fs'
import * as path from 'path'

export const maxDuration = 600

function toPublicImageUrl(keyOrUrl: string): string {
  if (keyOrUrl.startsWith('http') || keyOrUrl.startsWith('data:')) return keyOrUrl
  const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT || 'http://127.0.0.1:5000'
  return `${domain}/api/images?key=${encodeURIComponent(keyOrUrl)}`
}

/**
 * 分镜关联角色的形象参考图（项目人物；人物库需已导入并挂到分镜）
 * 拼图只负责剧情分镜，成片长相以这些图为准
 */
async function resolveCharacterAppearanceRefs(sceneId: string): Promise<
  { name: string; appearance: string; imageUrl: string }[]
> {
  let characterIds: string[] = []
  const memScene = memoryScenes.find((s) => s.id === sceneId)
  if (memScene?.characterIds?.length) {
    characterIds = [...memScene.characterIds]
  }

  if (isDatabaseConfigured()) {
    const { data: scene } = await getSupabaseClient()
      .from('scenes')
      .select('character_ids')
      .eq('id', sceneId)
      .maybeSingle()
    if (Array.isArray(scene?.character_ids) && scene.character_ids.length > 0) {
      characterIds = scene.character_ids.filter((id: unknown) => typeof id === 'string')
    }
  }

  if (characterIds.length === 0) return []

  const results: { name: string; appearance: string; imageUrl: string }[] = []

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

    if (imageUrl) {
      results.push({ name: name || '角色', appearance, imageUrl })
    }
  }

  return results
}

/** 上一镜完整上下文：整段剧情文案 + 身体状态 + 分解拼图 + 成片 */
type PreviousSceneContext = {
  sceneNumber: number
  title?: string
  description?: string
  action?: string
  dialogue?: string
  emotion?: string
  startState?: string
  endState?: string
  continuity?: string
  sheetUrl?: string
  videoUrl?: string
}

/** 查找上一镜：整段剧情 + 可选分解拼图（metadata.referenceSheetUrl） */
async function resolvePreviousSceneContext(
  sceneId: string,
  projectIdHint?: string,
  previousSheetUrlHint?: string
): Promise<PreviousSceneContext | null> {
  let projectId = projectIdHint || ''
  let sceneNumber = 0

  const memScene = memoryScenes.find((s) => s.id === sceneId)
  if (memScene) {
    projectId = projectId || memScene.projectId
    sceneNumber = memScene.sceneNumber
  }

  if (isDatabaseConfigured()) {
    const { data: cur } = await getSupabaseClient()
      .from('scenes')
      .select('project_id, scene_number')
      .eq('id', sceneId)
      .maybeSingle()
    if (cur) {
      projectId = cur.project_id || projectId
      sceneNumber = cur.scene_number || sceneNumber
    }
  }

  if (!projectId || !sceneNumber || sceneNumber <= 1) {
    // 仅有 URL hint、无法定位上一镜序号时，至少保留拼图视觉
    if (previousSheetUrlHint) {
      return { sceneNumber: 0, sheetUrl: previousSheetUrlHint }
    }
    return null
  }

  const prevNumber = sceneNumber - 1

  const memPrev = memoryScenes.find(
    (s) => s.projectId === projectId && s.sceneNumber === prevNumber
  )
  if (memPrev) {
    const memUrl = memPrev.metadata?.referenceSheetUrl
    const memState = readStateFromMetadata(memPrev.metadata)
    return {
      sceneNumber: prevNumber,
      title: memPrev.title,
      description: memPrev.description,
      action: memPrev.action,
      dialogue: memPrev.dialogue,
      emotion: memPrev.emotion,
      startState: memState.startState,
      endState: memState.endState,
      continuity: memState.continuity,
      sheetUrl:
        previousSheetUrlHint ||
        (typeof memUrl === 'string' && memUrl ? memUrl : undefined),
      videoUrl: memPrev.videoUrl || undefined,
    }
  }

  if (isDatabaseConfigured()) {
    const { data: prev } = await getSupabaseClient()
      .from('scenes')
      .select(
        'id, scene_number, title, description, action, dialogue, emotion, metadata, video_url'
      )
      .eq('project_id', projectId)
      .eq('scene_number', prevNumber)
      .maybeSingle()
    if (prev) {
      const meta = prev.metadata as Record<string, unknown> | null
      const metaUrl = meta?.referenceSheetUrl
      const dbState = readStateFromMetadata(meta)
      return {
        sceneNumber: prevNumber,
        title: prev.title || undefined,
        description: prev.description || undefined,
        action: prev.action || undefined,
        dialogue: prev.dialogue || undefined,
        emotion: prev.emotion || undefined,
        startState: dbState.startState,
        endState: dbState.endState,
        continuity: dbState.continuity,
        sheetUrl:
          previousSheetUrlHint ||
          (typeof metaUrl === 'string' && metaUrl ? metaUrl : undefined),
        videoUrl: prev.video_url || undefined,
      }
    }
  }

  if (previousSheetUrlHint) {
    return { sceneNumber: prevNumber, sheetUrl: previousSheetUrlHint }
  }

  return null
}

/** 把当前拼图写回分镜 metadata */
async function persistCurrentSheetToScene(
  sceneId: string,
  sheetUrl: string
): Promise<void> {
  const memIdx = memoryScenes.findIndex((s) => s.id === sceneId)
  if (memIdx !== -1) {
    memoryScenes[memIdx].metadata = {
      ...(memoryScenes[memIdx].metadata || {}),
      referenceSheetUrl: sheetUrl,
    }
  }
  if (!isDatabaseConfigured()) return
  try {
    const supabase = getSupabaseClient()
    const { data: existing } = await supabase
      .from('scenes')
      .select('metadata')
      .eq('id', sceneId)
      .maybeSingle()
    await supabase
      .from('scenes')
      .update({
        metadata: {
          ...((existing?.metadata as Record<string, unknown>) || {}),
          referenceSheetUrl: sheetUrl,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', sceneId)
  } catch (err) {
    console.warn('[Video Reference] persist current sheet failed:', err)
  }
}

async function persistDataUrlOrBuffer(
  sceneId: string,
  index: number,
  source: string
): Promise<{ url: string; key: string }> {
  let buffer: Buffer
  let ext = 'png'
  let contentType = 'image/png'

  if (source.startsWith('data:image/')) {
    const match = source.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/)
    if (!match) throw new Error('无效的图片 data URL')
    contentType = match[1]
    ext = contentType.split('/')[1] === 'jpeg' ? 'jpg' : contentType.split('/')[1] || 'png'
    buffer = Buffer.from(match[2], 'base64')
  } else if (source.startsWith('http') || source.startsWith('/')) {
    const { downloadFile } = await import('@/lib/utils')
    const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT || 'http://127.0.0.1:5000'
    const fetchUrl = source.startsWith('/') ? `${domain}${source}` : source
    // 本机代理图直接按 key 读更稳
    const keyGuess = extractStorageKeyFromUrl(source)
    if (keyGuess) {
      const { getObjectBuffer } = await import('@/lib/storage')
      const obj = await getObjectBuffer(keyGuess)
      if (obj) {
        return { url: `/api/images?key=${encodeURIComponent(keyGuess)}`, key: keyGuess }
      }
    }
    buffer = await downloadFile(fetchUrl)
  } else {
    throw new Error('不支持的图片格式')
  }

  const key = `scenes/${sceneId}/keyframes/upload_${index + 1}_${Date.now()}.${ext}`
  try {
    await uploadFile(key, buffer, contentType)
    return { url: `/api/images?key=${encodeURIComponent(key)}`, key }
  } catch {
    const dir = path.join(process.cwd(), 'public', 'scenes', sceneId, 'keyframes')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const filename = `upload_${index + 1}_${Date.now()}.${ext}`
    fs.writeFileSync(path.join(dir, filename), buffer)
    const localUrl = `/scenes/${sceneId}/keyframes/${filename}`
    return { url: localUrl, key: `${sceneId}/keyframes/${filename}` }
  }
}

/**
 * POST /api/generate/videos/reference
 * 多模态参考模式：用 4-6 张分解图生成一段视频
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      sceneId,
      projectId,
      referenceImages,
      duration = 5,
      ratio = '16:9',
      dialogue,
      action,
      emotion,
      mode = 'frames', // 'frames' = 多张关键帧；'sheet' = 一张多分格拼图
      previousSheetUrl, // 上一镜分解拼图（可选；服务端也会自动查找）
      previousVideoUrl, // 上一镜成片（可选；服务端也会自动查找并裁末尾）
      persistSheetOnly = false, // 仅保存拼图到分镜，不生成视频
    } = body as {
      sceneId?: string
      projectId?: string
      referenceImages?: string[]
      duration?: number
      ratio?: '16:9' | '9:16'
      dialogue?: string
      action?: string
      emotion?: string
      mode?: 'frames' | 'sheet'
      previousSheetUrl?: string
      previousVideoUrl?: string
      persistSheetOnly?: boolean
    }

    if (!sceneId) {
      return NextResponse.json({ error: '缺少 sceneId' }, { status: 400 })
    }

    const images = (referenceImages || []).filter(Boolean)
    const isSheetMode = mode === 'sheet' || images.length === 1

    // 仅持久化拼图（上传回显用）
    if (persistSheetOnly) {
      if (images.length < 1) {
        return NextResponse.json({ error: '请提供拼图' }, { status: 400 })
      }
      let sheetUrl = images[0]
      if (sheetUrl.startsWith('data:')) {
        const saved = await persistDataUrlOrBuffer(sceneId, 0, sheetUrl)
        sheetUrl = saved.url
      }
      await persistCurrentSheetToScene(sceneId, sheetUrl)
      return NextResponse.json({
        success: true,
        sceneId,
        sheetUrl,
        persisted: true,
      })
    }

    if (isSheetMode) {
      if (images.length < VIDEO_REFERENCE_FRAME_COUNT.sheetMin) {
        return NextResponse.json({ error: '请提供 1 张动作分解拼图' }, { status: 400 })
      }
    } else {
      if (images.length < VIDEO_REFERENCE_FRAME_COUNT.min) {
        return NextResponse.json(
          {
            error: `请提供至少 ${VIDEO_REFERENCE_FRAME_COUNT.min} 张分解图（推荐 ${VIDEO_REFERENCE_FRAME_COUNT.recommended} 张），或改用一张拼图模式`,
          },
          { status: 400 }
        )
      }
      if (images.length > VIDEO_REFERENCE_FRAME_COUNT.max) {
        return NextResponse.json(
          { error: `分解图最多 ${VIDEO_REFERENCE_FRAME_COUNT.max} 张` },
          { status: 400 }
        )
      }
    }

    // 读取分镜
    let scene: any = memoryScenes.find((s) => s.id === sceneId) || null
    let stylePrompt = ''

    if (isDatabaseConfigured()) {
      const supabase = getSupabaseClient()
      const { data } = await supabase.from('scenes').select('*').eq('id', sceneId).maybeSingle()
      if (data) {
        scene = {
          id: data.id,
          description: data.description,
          dialogue: data.dialogue,
          action: data.action,
          emotion: data.emotion,
          projectId: data.project_id,
          metadata: data.metadata || {},
        }
      }
      const pid = projectId || scene?.projectId || scene?.project_id
      if (pid) {
        const { data: project } = await supabase
          .from('projects')
          .select('style, custom_style_prompt')
          .eq('id', pid)
          .maybeSingle()
        if (project) {
          stylePrompt = getVideoStylePrompt(project.style || 'realistic_cinema')
          if (project.custom_style_prompt) {
            stylePrompt = `${stylePrompt}，${project.custom_style_prompt}`
          }
        }
      }
    }

    if (!scene && !memoryScenes.find((s) => s.id === sceneId)) {
      return NextResponse.json({ error: '分镜不存在' }, { status: 404 })
    }

    const memProject = memoryProjects.find((p) => p.id === (projectId || scene?.projectId))
    if (!stylePrompt && memProject) {
      stylePrompt = getVideoStylePrompt(memProject.style || 'realistic_cinema')
      if (memProject.customStylePrompt) {
        stylePrompt = `${stylePrompt}，${memProject.customStylePrompt}`
      }
    }

    // 持久化上传的 data URL，统一成可引用地址（拼图 / 关键帧 = 剧情分镜）
    const persisted: string[] = []
    for (let i = 0; i < images.length; i++) {
      const src = images[i]
      if (src.startsWith('data:')) {
        const saved = await persistDataUrlOrBuffer(sceneId, i, src)
        persisted.push(saved.url)
      } else {
        persisted.push(src)
      }
    }

    // 当前拼图写回分镜，方便下一镜衔接
    if (isSheetMode && persisted[0]) {
      await persistCurrentSheetToScene(sceneId, persisted[0])
    }

    // 上一镜整段剧情 + 整张拼图 + 成片末尾参考视频
    const previousScene = await resolvePreviousSceneContext(
      sceneId,
      projectId,
      previousSheetUrl
    )
    if (previousScene && previousVideoUrl && !previousScene.videoUrl) {
      previousScene.videoUrl = previousVideoUrl
    }

    // 裁切上一镜成片末尾约 2 秒作为 Seedance 参考视频（动作衔接优先）
    let continuityTailUrl: string | undefined
    let continuityTailSeconds = 0
    const prevVideoSource = previousScene?.videoUrl || previousVideoUrl
    if (prevVideoSource) {
      const tail = await createPreviousSceneTailClip(
        prevVideoSource,
        sceneId,
        CONTINUITY_TAIL_SECONDS
      )
      if (tail?.url) {
        continuityTailUrl = tail.url
        continuityTailSeconds = tail.seconds
        console.log('[Video Reference] continuity tail ready:', {
          seconds: tail.seconds,
          sourceDuration: tail.sourceDuration,
          urlPreview: tail.url.slice(0, 80),
        })
      }
    }

    // 角色形象参考：拼图只管剧情，成片人物长相以人物设定图为准
    const characterRefs = await resolveCharacterAppearanceRefs(sceneId)
    const maxTotalRefs = 9
    // 顺序：当前拼图 → 上一镜拼图 → 角色设定图
    const storyboardRefs = [...persisted]
    if (previousScene?.sheetUrl && !storyboardRefs.includes(previousScene.sheetUrl)) {
      storyboardRefs.push(previousScene.sheetUrl)
    }
    const remainingSlots = Math.max(0, maxTotalRefs - storyboardRefs.length)
    const characterImages = characterRefs.slice(0, remainingSlots).map((c) => c.imageUrl)
    const allRefs = [...storyboardRefs, ...characterImages]

    const prevSheetImageIndex = previousScene?.sheetUrl
      ? storyboardRefs.findIndex((u) => u === previousScene.sheetUrl) + 1
      : -1

    const prevLabel =
      previousScene?.sceneNumber && previousScene.sceneNumber > 0
        ? `分镜${previousScene.sceneNumber}`
        : '上一镜'

    const prevPlotLines = previousScene
      ? [
          previousScene.title ? `标题「${previousScene.title}」` : '',
          previousScene.description
            ? `场景：${previousScene.description}`
            : '',
          previousScene.action ? `动作：${previousScene.action}` : '',
          previousScene.endState
            ? `收束状态 endState：${previousScene.endState}`
            : '',
          previousScene.startState
            ? `（上一镜开场曾为：${previousScene.startState}）`
            : '',
          previousScene.dialogue
            ? `对白/旁白：${previousScene.dialogue}`
            : '',
          previousScene.emotion ? `情绪：${previousScene.emotion}` : '',
        ].filter(Boolean)
      : []

    const currentState = readStateFromMetadata(
      scene?.metadata as Record<string, unknown> | null | undefined
    )

    const continuityHint = previousScene
      ? [
          `【上一镜整段剧情必须承接】${prevLabel}的完整故事：${
            prevPlotLines.length > 0
              ? prevPlotLines.join('；')
              : '见上一镜分解拼图时间线'
          }`,
          continuityTailUrl
            ? `参考视频 video1 是${prevLabel}成片的最后约 ${continuityTailSeconds || CONTINUITY_TAIL_SECONDS} 秒：本段开场必须无缝衔接该视频结尾的姿态、握姿、朝向、运动惯性与空间位置，禁止硬切跳变或重演整段旧戏`
            : '',
          prevSheetImageIndex > 0
            ? `参考图 image${prevSheetImageIndex} 是${prevLabel}的完整动作分解拼图，代表上一镜整段剧情的视觉时间线（从左到右、从上到下，每格约 1 秒）；有参考视频时以视频末尾动作为开场第一优先`
            : !continuityTailUrl
              ? `${prevLabel}暂无成片与拼图，请仅依据上文剧情与状态文案做叙事承接`
              : '',
          '请先完整理解上一镜：起因→发展→收束，人物动机、空间关系、道具状态、情绪弧线如何走到现在',
          previousScene.endState
            ? `硬约束：本段开场身体与持物状态必须等于上一镜 endState「${previousScene.endState}」（握姿/出鞘进度/站姿或冲刺/朝向不得擅自改成正握、站定等另一种状态）`
            : '硬约束：本段开场必须继承上一镜收束后的整体结果，禁止无因换姿换握',
          currentState.startState
            ? `本镜开场状态 startState「${currentState.startState}」必须与上一镜 endState 一致；若与参考视频末帧冲突，以参考视频可见姿态为准并保持连续`
            : '',
          currentState.endState
            ? `本镜收束状态 endState「${currentState.endState}」`
            : '',
          '本段视频是上一镜整段剧情的自然续写：因果、人物状态、场景逻辑必须接得上，禁止无因无果的跳切',
          '不要把上一镜整段动作重新演一遍；参考视频只负责开场衔接，本镜新内容以 image1 拼图与本镜文案为准',
        ].filter(Boolean)
      : currentState.startState || currentState.endState
        ? [
            currentState.startState
              ? `本镜开场状态 startState：${currentState.startState}`
              : '',
            currentState.endState
              ? `本镜收束状态 endState：${currentState.endState}`
              : '',
          ].filter(Boolean)
        : []

    const characterPromptHint =
      characterRefs.length > 0
        ? [
            `另附 ${Math.min(characterRefs.length, remainingSlots)} 张角色设定参考图：${characterRefs
              .slice(0, remainingSlots)
              .map(
                (c, i) =>
                  `image${storyboardRefs.length + i + 1}=${c.name}${c.appearance ? `（${c.appearance}）` : ''}`
              )
              .join('；')}`,
            '这些角色设定图是彩铅/插画概念图，仅用于锁定人物身份与外形（脸型、发型、五官、服装）',
            '成片必须把角色从彩铅插画还原为写实照片风格，超写实人像摄影，但五官发型服装与设定图严格一致，禁止换脸',
            '当前镜拼图仅提供动作与剧情节拍，不要用拼图格子里的简笔画脸',
          ]
        : [
            '成片画面为写实照片风格，超写实人像摄影',
            '若无角色设定图，则尽量保持拼图中角色外观自洽',
          ]

    const qualityConstraints = [
      '成片整体为写实电影摄影质感，真实光影与皮肤质感，不是插画、不是彩铅、不是动漫',
      '角色外形特征保持与角色设定参考图一致，不要变形、不要换脸',
      '不要中文乱码或乱码文字',
      '不要出现多余角色',
      '镜头节奏快，动作干脆利落',
    ]

    const orderedPrompt = isSheetMode
      ? [
          '成片风格：写实照片风格，超写实人像摄影，电影级真实光影',
          stylePrompt ? `场景气质参考：${stylePrompt}` : '',
          '参考图 image1 是本镜「动作分解分镜拼图」，宫格时间线从左到右、从上到下，每格约 1 秒，只用于本镜剧情与动作',
          '请按本镜拼图格子顺序生成连贯短视频，平滑过渡各格动作',
          '不要把拼图边框/时间戳文字硬画进成片',
          ...continuityHint,
          ...characterPromptHint,
          ...qualityConstraints,
          scene?.description ? `场景：${scene.description}` : '',
          (action || scene?.action) ? `动作：${action || scene.action}` : '',
          currentState.startState
            ? `开场状态：${currentState.startState}`
            : '',
          currentState.endState ? `收束状态：${currentState.endState}` : '',
          (dialogue || scene?.dialogue) ? `对白/旁白：${dialogue || scene.dialogue}` : '',
          (emotion || scene?.emotion) ? `情绪：${emotion || scene.emotion}` : '',
          `时长约 ${duration} 秒`,
        ]
          .filter(Boolean)
          .join('。')
      : [
          '成片风格：写实照片风格，超写实人像摄影，电影级真实光影',
          stylePrompt ? `场景气质参考：${stylePrompt}` : '',
          `请根据参考图 image1 到 image${persisted.length} 按时间顺序生成连贯短视频（这些是本镜动作分解关键帧）`,
          '请平滑过渡，保持场景空间一致',
          ...continuityHint,
          ...characterPromptHint,
          ...qualityConstraints,
          scene?.description ? `场景：${scene.description}` : '',
          (action || scene?.action) ? `动作：${action || scene.action}` : '',
          currentState.startState
            ? `开场状态：${currentState.startState}`
            : '',
          currentState.endState ? `收束状态：${currentState.endState}` : '',
          (dialogue || scene?.dialogue) ? `对白/旁白：${dialogue || scene.dialogue}` : '',
          (emotion || scene?.emotion) ? `情绪：${emotion || scene.emotion}` : '',
          `时长约 ${duration} 秒`,
        ]
          .filter(Boolean)
          .join('。')

    console.log(
      '[Video Reference] Generating with',
      allRefs.length,
      'refs (current=',
      persisted.length,
      ', previousScene=',
      previousScene ? 1 : 0,
      ', characters=',
      characterImages.length,
      '), mode=',
      isSheetMode ? 'sheet' : 'frames'
    )
    console.log(
      '[Video Reference] characters:',
      characterRefs.map((c) => c.name)
    )
    if (previousScene) {
      console.log('[Video Reference] previous scene continuity:', {
        sceneNumber: previousScene.sceneNumber,
        hasSheet: Boolean(previousScene.sheetUrl),
        hasVideo: Boolean(previousScene.videoUrl || previousVideoUrl),
        hasTailClip: Boolean(continuityTailUrl),
        title: previousScene.title,
        hasDescription: Boolean(previousScene.description),
        hasAction: Boolean(previousScene.action),
      })
    }

    // 更新状态
    if (isDatabaseConfigured()) {
      await getSupabaseClient()
        .from('scenes')
        .update({ video_status: 'generating', updated_at: new Date().toISOString() })
        .eq('id', sceneId)
    }
    const memIdx = memoryScenes.findIndex((s) => s.id === sceneId)
    if (memIdx !== -1) memoryScenes[memIdx].videoStatus = 'generating'

    const result = await generateVideoFromReferenceImages(orderedPrompt, allRefs, {
      model: DEFAULT_VIDEO_MODEL,
      duration: Math.min(15, Math.max(4, Number(duration) || 5)),
      ratio: ratio === '9:16' ? '9:16' : '16:9',
      resolution: '720p',
      generateAudio: true,
      ...(continuityTailUrl ? { referenceVideoUrls: [continuityTailUrl] } : {}),
    })

    // 落库视频
    let videoUrl = result.videoUrl
    try {
      const { downloadFile } = await import('@/lib/utils')
      const videoBuffer = await downloadFile(result.videoUrl)
      const videoKey = `scenes/${sceneId}/video_ref_${Date.now()}.mp4`
      try {
        const uploaded = await uploadFile(videoKey, videoBuffer, 'video/mp4')
        // 本机 MinIO 直链浏览器可能不便，下载走 key；库内保留可识别的代理/上传结果
        videoUrl = uploaded.startsWith('/')
          ? uploaded
          : (uploaded.includes('127.0.0.1') || uploaded.includes('localhost')
              ? `/api/images?key=${encodeURIComponent(videoKey)}`
              : uploaded)
      } catch {
        const dir = path.join(process.cwd(), 'public', 'videos', sceneId)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const filename = `video_ref_${Date.now()}.mp4`
        fs.writeFileSync(path.join(dir, filename), videoBuffer)
        videoUrl = `/videos/${sceneId}/${filename}`
      }
    } catch (e) {
      console.warn('[Video Reference] rehost failed, use original url', e)
    }

    if (isDatabaseConfigured()) {
      // 合并最新 metadata，避免冲掉 referenceSheetUrl
      let existingMeta: Record<string, unknown> = {}
      try {
        const { data: latest } = await getSupabaseClient()
          .from('scenes')
          .select('metadata')
          .eq('id', sceneId)
          .maybeSingle()
        if (latest?.metadata && typeof latest.metadata === 'object') {
          existingMeta = latest.metadata as Record<string, unknown>
        }
      } catch {
        existingMeta =
          scene?.metadata && typeof scene.metadata === 'object' ? scene.metadata : {}
      }

      const sheetUrlForMeta =
        (typeof existingMeta.referenceSheetUrl === 'string' && existingMeta.referenceSheetUrl) ||
        persisted[0] ||
        undefined

      await getSupabaseClient()
        .from('scenes')
        .update({
          video_url: videoUrl,
          video_status: 'completed',
          status: 'completed',
          updated_at: new Date().toISOString(),
          metadata: {
            ...existingMeta,
            videoMode: 'multimodal_reference',
            referenceFrameCount: persisted.length,
            ...(sheetUrlForMeta ? { referenceSheetUrl: sheetUrlForMeta } : {}),
          },
        })
        .eq('id', sceneId)
    }
    if (memIdx !== -1) {
      memoryScenes[memIdx].videoUrl = videoUrl
      memoryScenes[memIdx].videoStatus = 'completed'
      memoryScenes[memIdx].status = 'completed'
      if (persisted[0]) {
        memoryScenes[memIdx].metadata = {
          ...(memoryScenes[memIdx].metadata || {}),
          referenceSheetUrl: persisted[0],
          videoMode: 'multimodal_reference',
          referenceFrameCount: persisted.length,
        }
      }
    }

    return NextResponse.json({
      success: true,
      sceneId,
      videoUrl,
      sheetUrl: persisted[0] || null,
      referenceCount: persisted.length,
      duration,
    })
  } catch (error) {
    console.error('[Video Reference] error:', error)
    const msg = error instanceof Error ? error.message : '多模态参考视频生成失败'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
