import { NextRequest, NextResponse } from "next/server"
import { HeaderUtils, S3Storage } from "coze-coding-dev-sdk"
import { getSupabaseClient, isDatabaseConfigured } from "@/storage/database/supabase-client"
import { memoryCharacters } from "@/lib/memory-storage"
import { getCharacterStylePrompt } from "@/lib/styles"
import { generateImage } from "@/lib/ai"
import { downloadFile } from "@/lib/utils"

// POST /api/generate/character-views - 生成人物三视图（短剧角色设定）
export async function POST(request: NextRequest) {
  const { characterId, appearance } = await request.json()

  if (!characterId || !appearance) {
    return NextResponse.json(
      { error: "缺少必要参数" },
      { status: 400 }
    )
  }

  // 提取请求头用于转发
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers)

  console.log('[Character Views] Starting generation for:', characterId)

  try {
    // 角色设定图固定彩铅风格（视频阶段再还原写实）
    const stylePrompt = getCharacterStylePrompt()
    const basePrompt = `${stylePrompt}，${appearance}，角色三视图包含正面、侧面、背面三个角度，白色背景，用于角色设定参考`

    console.log(`Generating character views for ${characterId}:`, basePrompt.substring(0, 100))

    // 使用统一的图像生成接口（优先 base64，避免临时 CDN 下载失败）
    let imageUrl = ''
    let imageBuffer: Buffer
    try {
      const result = await generateImage(
        basePrompt,
        {
          size: '2K',
          watermark: false,
          responseFormat: 'b64_json',
        },
        undefined,
        customHeaders
      )

      imageUrl =
        (result.b64List?.[0] ? `data:image/png;base64,${result.b64List[0]}` : '') ||
        result.urls[0] ||
        ''
      if (!imageUrl) {
        throw new Error('图像生成未返回可用图片')
      }
      console.log('[Character Views] Image generated successfully:', imageUrl.slice(0, 120))
      imageBuffer = await downloadFile(imageUrl)
    } catch (genError) {
      console.error('[Character Views] Generate/download error:', genError)
      return NextResponse.json(
        { error: genError instanceof Error ? genError.message : '图像生成失败' },
        { status: 500 }
      )
    }

    // 上传到对象存储（MinIO / S3 / OSS），失败则落本地 public/
    let fileKey: string | null = null
    let viewUrl: string = imageUrl

    const s3Endpoint = process.env.S3_ENDPOINT || process.env.COZE_BUCKET_ENDPOINT_URL || ""
    const s3AccessKey = process.env.S3_ACCESS_KEY || ""
    const s3Configured =
      !!s3Endpoint &&
      !!s3AccessKey &&
      !s3Endpoint.includes("your-bucket") &&
      !s3AccessKey.includes("your-access")

    try {
      if (!s3Configured) {
        throw new Error("S3/MinIO not configured, use local storage")
      }

      const { uploadFile, getPublicUrl } = await import("@/lib/storage")
      fileKey = `${characterId}/views_${Date.now()}.png`
      viewUrl = await uploadFile(fileKey, imageBuffer, "image/png")
      if (!viewUrl) {
        viewUrl = getPublicUrl(fileKey)
      }

      console.log("Image uploaded to object storage:", fileKey)
      console.log("Image URL:", viewUrl)
    } catch (ossError) {
      console.warn("Failed to upload to object storage, saving to local:", ossError)

      try {
        const fs = await import('fs')
        const path = await import('path')

        const publicDir = path.join(process.cwd(), 'public', 'characters', characterId)
        if (!fs.existsSync(publicDir)) {
          fs.mkdirSync(publicDir, { recursive: true })
        }

        const localFileName = `views_${Date.now()}.png`
        const localFilePath = path.join(publicDir, localFileName)
        fs.writeFileSync(localFilePath, imageBuffer)

        fileKey = `${characterId}/${localFileName}`
        viewUrl = `/characters/${fileKey}`

        console.log("Image saved to local:", localFilePath)
      } catch (localError) {
        console.warn("Failed to save to local:", localError)
      }
    }

    // 更新数据库
    if (isDatabaseConfigured()) {
      try {
        const supabase = getSupabaseClient()
        
        // 先只更新 front_view_key（确保至少能更新这个字段）
        const { error } = await supabase
          .from("characters")
          .update({
            front_view_key: fileKey,  // 存储相对路径，更短
            updated_at: new Date().toISOString(),
          })
          .eq("id", characterId)

        if (error) {
          console.warn("Database update error:", error.message)
        } else {
          console.log("Database updated with front_view_key:", fileKey)
          
          // 尝试更新 image_url（如果 schema cache 已刷新）
          try {
            const { error: imageError } = await supabase
              .from("characters")
              .update({ image_url: viewUrl })
              .eq("id", characterId)
            
            if (imageError) {
              console.warn("Failed to update image_url (schema cache may need refresh):", imageError.message)
            } else {
              console.log("Database updated with image_url:", viewUrl)
            }
          } catch (imageErr) {
            console.warn("Failed to update image_url:", imageErr)
          }
        }
      } catch (dbError) {
        console.warn("Failed to update database:", dbError)
      }
    }

    // 更新内存存储
    const charIndex = memoryCharacters.findIndex((c) => c.id === characterId)
    if (charIndex !== -1) {
      memoryCharacters[charIndex].frontViewKey = fileKey || undefined
      memoryCharacters[charIndex].imageUrl = viewUrl
    }

    return NextResponse.json({
      success: true,
      viewUrl,
      fileKey,
    })
  } catch (error) {
    console.error("Generate character views error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成人物视图失败" },
      { status: 500 }
    )
  }
}
