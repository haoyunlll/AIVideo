import { NextRequest, NextResponse } from "next/server"
import { existsSync } from "fs"
import { join } from "path"
import { readFile } from "fs/promises"
import {
  extractStorageKeyFromUrl,
  getObjectBuffer,
  isLocalStorageEndpoint,
  normalizeObjectKey,
} from "@/lib/storage"

function isPlaceholderS3Endpoint(endpoint?: string | null): boolean {
  if (!endpoint) return true
  return (
    endpoint.includes("your-bucket") ||
    endpoint.includes("your-access") ||
    endpoint.includes("example.com")
  )
}

function guessContentType(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".mp4")) return "video/mp4"
  return "application/octet-stream"
}

/**
 * 按 key 在本地 public 目录查找文件
 */
function resolveLocalPath(key: string): string | null {
  const normalized = key.replace(/^\/+/, "").replace(/\\/g, "/")
  const publicRoot = join(process.cwd(), "public")

  const candidates = [
    join(publicRoot, normalized),
    join(publicRoot, "characters", normalized),
    join(publicRoot, "scenes", normalized),
  ]

  if (normalized.startsWith("characters/")) {
    candidates.push(join(publicRoot, normalized.slice("characters/".length)))
  }
  if (normalized.startsWith("scenes/")) {
    candidates.push(join(publicRoot, normalized.slice("scenes/".length)))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

// GET /api/images - 优先本地文件，其次用凭证从 MinIO/S3 代理，最后才重定向公网 OSS
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const keyParam = searchParams.get("key")

  console.log("[API Images] Received request, key:", keyParam)

  if (!keyParam) {
    return NextResponse.json({ error: "缺少 key 参数" }, { status: 400 })
  }

  try {
    // 兼容误传完整 MinIO URL 的情况
    const key =
      extractStorageKeyFromUrl(keyParam) ||
      normalizeObjectKey(keyParam)

    // 1) 本地 public 文件
    const localPath = resolveLocalPath(key)
    if (localPath) {
      console.log("[API Images] Serving local file:", localPath)
      const buffer = await readFile(localPath)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type": guessContentType(localPath),
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      })
    }

    // 2) 用凭证从 MinIO/S3 代理（解决本机 MinIO 匿名 403）
    const endpoint = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || process.env.COZE_BUCKET_ENDPOINT_URL
    if (!isPlaceholderS3Endpoint(endpoint)) {
      const obj = await getObjectBuffer(key)
      if (obj) {
        console.log("[API Images] Serving from object storage via proxy:", key)
        return new NextResponse(new Uint8Array(obj.buffer), {
          status: 200,
          headers: {
            "Content-Type": obj.contentType || guessContentType(key),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        })
      }

      // 3) 非本机存储且代理失败时，尝试重定向到公网 URL
      if (!isLocalStorageEndpoint(endpoint)) {
        const bucket = process.env.S3_BUCKET || "drama-studio"
        const cleanEndpoint = endpoint!.replace(/\/$/, "")
        const cleanKey = key.replace(/^\/+/, "")
        const endpointHasBucket = cleanEndpoint.includes(bucket)
        const url = endpointHasBucket
          ? `${cleanEndpoint}/${cleanKey}`
          : `${cleanEndpoint}/${bucket}/${cleanKey}`
        console.log("[API Images] Redirecting to object storage:", url)
        return NextResponse.redirect(url, 302)
      }
    }

    console.warn("[API Images] Local file not found and object storage miss:", key)
    return NextResponse.json(
      {
        error: "图片不存在。请重新生成，或配置有效的 S3/OSS/MinIO。",
        key,
      },
      { status: 404 }
    )
  } catch (error) {
    console.error("获取图片失败:", error)
    return NextResponse.json({ error: "获取图片失败" }, { status: 500 })
  }
}
