import { NextRequest, NextResponse } from "next/server"
import { getSupabaseClient } from "@/storage/database/supabase-client"
import { insertEpisodeSchema } from "@/storage/database/shared/schema"
import { memoryEpisodes, memoryScenes, generateId } from "@/lib/memory-storage"

function createMemoryEpisode(data: {
  projectId: string
  seasonNumber: number
  episodeNumber: number
  title: string
  description?: string | null
  scriptIds?: string[]
  sceneIds?: string[]
  sceneStart?: number
  sceneEnd?: number
}) {
  const episode = {
    id: generateId("ep"),
    projectId: data.projectId,
    seasonNumber: data.seasonNumber,
    episodeNumber: data.episodeNumber,
    title: data.title,
    description: data.description || undefined,
    status: "draft",
    createdAt: new Date().toISOString(),
  }

  memoryEpisodes.push(episode)

  let sceneCount = 0
  if (data.scriptIds && data.scriptIds.length > 0) {
    const scenes = memoryScenes.filter(
      (s) =>
        s.projectId === data.projectId &&
        data.scriptIds!.includes(s.scriptId || "") &&
        !s.episodeId
    )
    for (const scene of scenes) {
      scene.episodeId = episode.id
      sceneCount++
    }
  } else if (data.sceneIds && data.sceneIds.length > 0) {
    for (const scene of memoryScenes) {
      if (data.sceneIds.includes(scene.id) && scene.projectId === data.projectId) {
        scene.episodeId = episode.id
        sceneCount++
      }
    }
  } else if (data.sceneStart !== undefined && data.sceneEnd !== undefined) {
    const unassigned = memoryScenes
      .filter((s) => s.projectId === data.projectId && !s.episodeId)
      .sort((a, b) => a.sceneNumber - b.sceneNumber)
    const slice = unassigned.slice(data.sceneStart - 1, data.sceneEnd)
    for (const scene of slice) {
      scene.episodeId = episode.id
      sceneCount++
    }
  }

  return { episode, sceneCount }
}

// GET /api/episodes - 获取项目的剧集列表
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get("projectId")

  if (!projectId) {
    return NextResponse.json({ error: "缺少项目ID" }, { status: 400 })
  }

  // 尝试从数据库获取
  try {
    // 使用 service_role，避免 RLS 拦截
    const client = getSupabaseClient(true)

    // 获取剧集列表，按季数和集数排序
    const { data: episodes, error } = await client
      .from("episodes")
      .select("*")
      .eq("project_id", projectId)
      .order("season_number", { ascending: true })
      .order("episode_number", { ascending: true })

    if (error) {
      console.warn("数据库查询剧集失败，回退到内存存储:", error.message)
      // 回退到内存存储
      const episodes = memoryEpisodes
        .filter(e => e.projectId === projectId)
        .sort((a, b) => {
          if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber
          return a.episodeNumber - b.episodeNumber
        })
        .map(ep => ({
          ...ep,
          sceneCount: memoryScenes.filter(s => s.episodeId === ep.id).length
        }))
      return NextResponse.json({ episodes })
    }

    // 获取所有分镜，按 episode_id 分组计数
    const { data: scenes, error: scenesError } = await client
      .from("scenes")
      .select("episode_id")
      .eq("project_id", projectId)

    if (scenesError) {
      console.warn("获取分镜失败:", scenesError.message)
    }

    // 计算每个剧集的分镜数量
    const sceneCounts: Record<string, number> = {}
    ;(scenes || []).forEach((scene: any) => {
      if (scene.episode_id) {
        sceneCounts[scene.episode_id] = (sceneCounts[scene.episode_id] || 0) + 1
      }
    })

    // 转换数据格式
    const formattedEpisodes = (episodes || []).map((ep: any) => ({
      ...ep,
      sceneCount: sceneCounts[ep.id] || 0,
    }))

    return NextResponse.json({ episodes: formattedEpisodes })
  } catch (err) {
    console.warn("数据库连接失败，回退到内存存储:", err)
    // 回退到内存存储
    const episodes = memoryEpisodes
      .filter(e => e.projectId === projectId)
      .sort((a, b) => {
        if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber
        return a.episodeNumber - b.episodeNumber
      })
      .map(ep => ({
        ...ep,
        sceneCount: memoryScenes.filter(s => s.episodeId === ep.id).length
      }))
    return NextResponse.json({ episodes })
  }
}

// POST /api/episodes - 创建新剧集
export async function POST(request: NextRequest) {
  const body = await request.json()

  const parsed = insertEpisodeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.issues },
      { status: 400 }
    )
  }

  const seasonNumber = parsed.data.seasonNumber || 1
  const episodeNumber = parsed.data.episodeNumber

  try {
    // 使用 service_role，与角色/分镜写入一致，避免 anon + RLS / 网络异常
    const client = getSupabaseClient(true)

    // 检查同一项目下是否已存在相同季数和集数的剧集
    const { data: existing, error: existingError } = await client
      .from("episodes")
      .select("id")
      .eq("project_id", parsed.data.projectId)
      .eq("season_number", seasonNumber)
      .eq("episode_number", episodeNumber)
      .maybeSingle()

    if (existingError) {
      console.warn("[Episodes API] Check existing failed:", existingError.message)
      // 表不存在或网络失败时回退内存
      if (
        existingError.message.includes("fetch failed") ||
        existingError.message.includes("Could not find the table") ||
        existingError.code === "42P01" ||
        existingError.code === "PGRST205"
      ) {
        console.warn("[Episodes API] Falling back to memory store for create")
        const result = createMemoryEpisode({
          projectId: parsed.data.projectId,
          seasonNumber,
          episodeNumber,
          title: parsed.data.title,
          description: parsed.data.description,
          scriptIds: body.scriptIds,
          sceneIds: body.sceneIds,
          sceneStart: body.sceneStart,
          sceneEnd: body.sceneEnd,
        })
        return NextResponse.json(result)
      }
    }

    if (existing) {
      return NextResponse.json(
        { error: "该季数和集数已存在" },
        { status: 400 }
      )
    }

    const { data: episode, error } = await client
      .from("episodes")
      .insert({
        id: generateId("ep"),
        project_id: parsed.data.projectId,
        season_number: seasonNumber,
        episode_number: episodeNumber,
        title: parsed.data.title,
        description: parsed.data.description,
      })
      .select()
      .single()

    if (error) {
      console.error("[Episodes API] Insert failed:", error.message, error)
      // 常见原因：未建 episodes 表、网络 fetch failed、RLS
      if (
        error.message.includes("fetch failed") ||
        error.message.includes("Could not find the table") ||
        error.code === "42P01" ||
        error.code === "PGRST205"
      ) {
        console.warn("[Episodes API] Falling back to memory store after insert failure")
        const result = createMemoryEpisode({
          projectId: parsed.data.projectId,
          seasonNumber,
          episodeNumber,
          title: parsed.data.title,
          description: parsed.data.description,
          scriptIds: body.scriptIds,
          sceneIds: body.sceneIds,
          sceneStart: body.sceneStart,
          sceneEnd: body.sceneEnd,
        })
        return NextResponse.json(result)
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // 如果指定了脚本ID，将属于该脚本的分镜分配到该剧集
    let sceneCount = 0
    if (body.scriptIds && Array.isArray(body.scriptIds) && body.scriptIds.length > 0) {
      const { data: unassignedScenes } = await client
        .from("scenes")
        .select("id, scene_number, script_id")
        .eq("project_id", parsed.data.projectId)
        .in("script_id", body.scriptIds)
        .is("episode_id", null)
        .order("script_id", { ascending: true })
        .order("scene_number", { ascending: true })

      if (unassignedScenes && unassignedScenes.length > 0) {
        const sceneIds = unassignedScenes.map((s: any) => s.id)
        await client
          .from("scenes")
          .update({ episode_id: episode.id, updated_at: new Date().toISOString() })
          .in("id", sceneIds)

        sceneCount = sceneIds.length
      }
    }
    // 如果指定了分镜ID，分配这些分镜到该剧集
    else if (body.sceneIds && Array.isArray(body.sceneIds) && body.sceneIds.length > 0) {
      const { data: scenesData } = await client
        .from("scenes")
        .select("id")
        .eq("project_id", parsed.data.projectId)
        .in("id", body.sceneIds)

      if (scenesData && scenesData.length > 0) {
        const sceneIds = scenesData.map((s: any) => s.id)
        await client
          .from("scenes")
          .update({ episode_id: episode.id, updated_at: new Date().toISOString() })
          .in("id", sceneIds)

        sceneCount = sceneIds.length
      }
    }
    // 如果指定了分镜范围，分配分镜到该剧集
    else if (body.sceneStart !== undefined && body.sceneEnd !== undefined) {
      const sceneStart = Math.max(1, body.sceneStart)
      const sceneEnd = Math.max(sceneStart, body.sceneEnd)

      const { data: unassignedScenes } = await client
        .from("scenes")
        .select("id")
        .eq("project_id", parsed.data.projectId)
        .is("episode_id", null)
        .order("scene_number", { ascending: true })

      if (unassignedScenes && unassignedScenes.length > 0) {
        const scenesToAssign = unassignedScenes.slice(sceneStart - 1, sceneEnd)

        if (scenesToAssign.length > 0) {
          const sceneIds = scenesToAssign.map((s: any) => s.id)
          await client
            .from("scenes")
            .update({ episode_id: episode.id, updated_at: new Date().toISOString() })
            .in("id", sceneIds)

          sceneCount = sceneIds.length
        }
      }
    }

    return NextResponse.json({ episode, sceneCount })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[Episodes API] Create exception:", message, err)

    // 网络层 TypeError: fetch failed 等 → 回退内存，保证本地可用
    if (message.includes("fetch failed") || message.includes("TypeError")) {
      const result = createMemoryEpisode({
        projectId: parsed.data.projectId,
        seasonNumber,
        episodeNumber,
        title: parsed.data.title,
        description: parsed.data.description,
        scriptIds: body.scriptIds,
        sceneIds: body.sceneIds,
        sceneStart: body.sceneStart,
        sceneEnd: body.sceneEnd,
      })
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
