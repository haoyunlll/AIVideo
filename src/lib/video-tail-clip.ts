/**
 * 裁切上一镜成片末尾若干秒，供 Seedance 参考视频衔接
 */

import { downloadFile } from '@/lib/utils'
import {
  uploadFile,
  isLocalStorageEndpoint,
  extractStorageKeyFromUrl,
  getObjectBuffer,
} from '@/lib/storage'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/** Seedance 参考视频常见最短时长（秒） */
export const CONTINUITY_TAIL_SECONDS = 2

async function loadVideoBuffer(url: string): Promise<Buffer> {
  // 本地 public 相对路径
  if (url.startsWith('/') && !url.startsWith('/api/')) {
    const localPath = join(process.cwd(), 'public', url.split('?')[0])
    if (existsSync(localPath)) {
      return readFileSync(localPath)
    }
  }

  // storage key /api/images?key=
  const key = extractStorageKeyFromUrl(url)
  if (key) {
    const obj = await getObjectBuffer(key)
    if (obj) return obj.buffer
  }

  // 相对站内路径补全域名
  let fetchUrl = url
  if (url.startsWith('/')) {
    const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT || 'http://127.0.0.1:5000'
    fetchUrl = `${domain}${url}`
  }

  return downloadFile(fetchUrl)
}

async function resolveFfmpegPaths(): Promise<{ ffmpeg: string; ffprobe: string }> {
  let ffmpegPath: string | null = null
  let ffprobePath: string | null = null

  try {
    const { getSupabaseClient, isDatabaseConfigured } = await import(
      '@/storage/database/supabase-client'
    )
    if (isDatabaseConfigured()) {
      const { data } = await getSupabaseClient()
        .from('user_settings')
        .select('ffmpeg_path, ffprobe_path')
        .maybeSingle()
      if (data?.ffmpeg_path) ffmpegPath = data.ffmpeg_path
      if (data?.ffprobe_path) ffprobePath = data.ffprobe_path
    }
  } catch {
    // ignore
  }

  const candidates = [
    ffmpegPath,
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\ffmpeg\\bin\\ffmpeg.exe`
      : null,
  ].filter((p): p is string => !!p)

  for (const candidate of candidates) {
    try {
      await execAsync(`"${candidate}" -version`, { timeout: 5000, windowsHide: true })
      return {
        ffmpeg: candidate,
        ffprobe:
          ffprobePath ||
          candidate.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),
      }
    } catch {
      // try next
    }
  }

  try {
    const check = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg'
    const { stdout } = await execAsync(check, { timeout: 5000, windowsHide: true })
    const systemPath = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (systemPath) {
      return {
        ffmpeg: systemPath,
        ffprobe: systemPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),
      }
    }
  } catch {
    // ignore
  }

  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
}

async function probeDuration(ffprobe: string, filePath: string): Promise<number> {
  const { stdout } = await execAsync(
    `"${ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    { timeout: 30000, windowsHide: true }
  )
  const n = parseFloat(stdout.trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error('无法读取视频时长')
  return n
}

/** Seedance reference_video 只接受公网 http(s)，拒绝 data URI / 本机地址 */
function isSeedancePublicWebUrl(url: string): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local')
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function isAliyunOssEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false
  return /aliyuncs\.com/i.test(endpoint) || /oss-cn-/i.test(endpoint)
}

/**
 * 将短视频片段上传为 Seedance 可访问的公网地址。
 * 无法得到公网 URL 时返回 null（勿传 data URI，API 会 400）。
 */
async function uploadClipForSeedance(
  buffer: Buffer,
  sceneId: string
): Promise<string | null> {
  const key = `scenes/${sceneId}/continuity_tail_${Date.now()}.mp4`

  // 1) 仅在明确配置了阿里云 OSS 时走 ali-oss（避免 MinIO 凭证误打 us-east-1.aliyuncs.com）
  try {
    const accessKeyId =
      process.env.ALIYUN_OSS_ACCESS_KEY_ID ||
      (isAliyunOssEndpoint(process.env.S3_ENDPOINT || process.env.S3_PUBLIC_ENDPOINT)
        ? process.env.S3_ACCESS_KEY
        : undefined)
    const accessKeySecret =
      process.env.ALIYUN_OSS_ACCESS_KEY_SECRET ||
      (isAliyunOssEndpoint(process.env.S3_ENDPOINT || process.env.S3_PUBLIC_ENDPOINT)
        ? process.env.S3_SECRET_KEY
        : undefined)
    const bucket =
      process.env.ALIYUN_OSS_BUCKET || process.env.S3_BUCKET || 'drama-studio'
    const region =
      process.env.ALIYUN_OSS_REGION ||
      (isAliyunOssEndpoint(process.env.S3_ENDPOINT || process.env.S3_PUBLIC_ENDPOINT)
        ? process.env.S3_REGION
        : undefined) ||
      'oss-cn-chengdu'
    const endpoint =
      process.env.ALIYUN_OSS_ENDPOINT ||
      process.env.COZE_BUCKET_ENDPOINT_URL ||
      (isAliyunOssEndpoint(process.env.S3_PUBLIC_ENDPOINT)
        ? process.env.S3_PUBLIC_ENDPOINT
        : undefined) ||
      (isAliyunOssEndpoint(process.env.S3_ENDPOINT) ? process.env.S3_ENDPOINT : undefined)

    if (accessKeyId && accessKeySecret && endpoint && isAliyunOssEndpoint(endpoint)) {
      const OSS = await import('ali-oss')
      const ossClient = new OSS.default({
        region,
        accessKeyId,
        accessKeySecret,
        bucket,
        secure: true,
      })
      await ossClient.put(key, buffer)
      await ossClient.putACL(key, 'public-read')
      const publicBase =
        process.env.S3_PUBLIC_ENDPOINT ||
        process.env.ALIYUN_OSS_ENDPOINT ||
        endpoint
      const url = `${publicBase.replace(/\/$/, '')}/${key}`
      if (isSeedancePublicWebUrl(url)) {
        console.log('[VideoTailClip] uploaded to OSS:', url.slice(0, 120))
        return url
      }
      console.warn('[VideoTailClip] OSS URL not public for Seedance:', url.slice(0, 80))
    }
  } catch (err) {
    console.warn('[VideoTailClip] OSS upload failed:', err)
  }

  // 2) 通用 S3 / MinIO：仅当返回真正公网 URL 时使用
  try {
    const url = await uploadFile(key, buffer, 'video/mp4')
    if (isSeedancePublicWebUrl(url) && !isLocalStorageEndpoint()) {
      return url
    }
    console.warn(
      '[VideoTailClip] storage URL not reachable by Seedance (need public http URL). Skip reference video.',
      { urlPreview: url.slice(0, 80), localStorage: isLocalStorageEndpoint() }
    )
    return null
  } catch (err) {
    console.warn('[VideoTailClip] S3 upload failed, skip reference video:', err)
    return null
  }
}

export type ContinuityTailResult = {
  url: string
  seconds: number
  sourceDuration: number
}

/**
 * 从上一镜成片裁切末尾约 tailSeconds 秒，返回 Seedance 可用的参考视频 URL
 */
export async function createPreviousSceneTailClip(
  previousVideoUrl: string,
  sceneIdForKey: string,
  tailSeconds: number = CONTINUITY_TAIL_SECONDS
): Promise<ContinuityTailResult | null> {
  if (!previousVideoUrl) return null

  const dir = join(tmpdir(), 'drama-continuity-tail')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stamp = Date.now()
  const inputPath = join(dir, `in_${stamp}.mp4`)
  const outputPath = join(dir, `out_${stamp}.mp4`)

  try {
    const sourceBuffer = await loadVideoBuffer(previousVideoUrl)
    writeFileSync(inputPath, sourceBuffer)

    const { ffmpeg, ffprobe } = await resolveFfmpegPaths()
    const sourceDuration = await probeDuration(ffprobe, inputPath)
    const clipLen = Math.min(Math.max(tailSeconds, CONTINUITY_TAIL_SECONDS), sourceDuration)
    if (clipLen < 1.5) {
      console.warn(
        '[VideoTailClip] source too short for Seedance reference video:',
        sourceDuration
      )
      return null
    }

    const start = Math.max(0, sourceDuration - clipLen)
    // 重编码保证切片干净，便于 API 接受
    const cmd =
      `"${ffmpeg}" -y -ss ${start.toFixed(3)} -i "${inputPath}" -t ${clipLen.toFixed(3)} ` +
      `-c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`

    console.log('[VideoTailClip] ffmpeg:', cmd)
    await execAsync(cmd, { timeout: 120000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 })

    if (!existsSync(outputPath)) {
      throw new Error('ffmpeg 未产出切片文件')
    }

    const clipBuffer = readFileSync(outputPath)
    const url = await uploadClipForSeedance(clipBuffer, sceneIdForKey)
    if (!url) {
      console.warn(
        '[VideoTailClip] no public web URL for continuity tail; generation will continue without reference_video'
      )
      return null
    }

    return {
      url,
      seconds: clipLen,
      sourceDuration,
    }
  } catch (err) {
    console.warn('[VideoTailClip] failed:', err)
    return null
  } finally {
    try {
      unlinkSync(inputPath)
    } catch {
      // ignore
    }
    try {
      unlinkSync(outputPath)
    } catch {
      // ignore
    }
  }
}
