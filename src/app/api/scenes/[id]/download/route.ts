import { NextRequest, NextResponse } from "next/server"
import { getSupabaseClient } from "@/storage/database/supabase-client"
import { extractStorageKeyFromUrl, getObjectBuffer } from "@/lib/storage"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

async function loadVideoBuffer(videoUrl: string): Promise<Buffer> {
  // 1) 从 URL / 代理地址提取 storage key，用凭证读 MinIO
  const key = extractStorageKeyFromUrl(videoUrl)
  if (key) {
    const obj = await getObjectBuffer(key)
    if (obj?.buffer?.length) {
      return obj.buffer
    }
  }

  // 2) 本地 public 相对路径：/videos/... /merged/...
  if (videoUrl.startsWith("/") && !videoUrl.startsWith("/api/")) {
    const localPath = join(process.cwd(), "public", videoUrl.split("?")[0])
    if (existsSync(localPath)) {
      return readFileSync(localPath)
    }
  }

  // 3) 绝对 URL 或本机代理：拼域名后下载
  let fetchUrl = videoUrl
  if (videoUrl.startsWith("/")) {
    const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT || "http://127.0.0.1:5000"
    fetchUrl = `${domain}${videoUrl}`
  }

  if (!/^https?:\/\//i.test(fetchUrl)) {
    throw new Error(`无效的视频地址: ${videoUrl}`)
  }

  const { downloadFile } = await import("@/lib/utils")
  return downloadFile(fetchUrl)
}

// GET /api/scenes/[id]/download - 下载单个分镜视频
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const client = getSupabaseClient()

  const { data: scene, error } = await client
    .from("scenes")
    .select("id, title, scene_number, video_url, image_key, image_url")
    .eq("id", id)
    .single()

  if (error || !scene) {
    return NextResponse.json({ error: "分镜不存在" }, { status: 404 })
  }

  if (!scene.video_url) {
    return NextResponse.json({ error: "该分镜尚未生成视频" }, { status: 400 })
  }

  try {
    console.log("[Scene Download] video_url:", scene.video_url.slice(0, 160))
    const videoBuffer = await loadVideoBuffer(scene.video_url)

    const fileName = `scene_${scene.scene_number}_${scene.title || "untitled"}.mp4`

    return new NextResponse(new Uint8Array(videoBuffer), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Content-Length": videoBuffer.length.toString(),
      },
    })
  } catch (err) {
    console.error("下载视频失败:", err)
    return NextResponse.json(
      {
        error: "下载视频失败",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
