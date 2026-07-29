/**
 * 存储服务统一接口
 * 使用 AWS S3 兼容协议对接 MinIO / 阿里云 OSS 等
 * 注意：对象 key 必须始终使用正斜杠 `/`，Windows 下 path.join 会产生 `\` 被 MinIO 拒绝
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3'
import { Errors, logger } from '@/lib/errors'

/** 存储配置 */
export interface StorageConfig {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  region: string
}

/** 规范化对象 key：统一为正斜杠，去掉开头斜杠 */
export function normalizeObjectKey(key: string): string {
  return key.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 获取默认存储配置 */
export function getStorageConfig(): StorageConfig {
  return {
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
    accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
    bucket: process.env.S3_BUCKET || 'drama-studio',
    region: process.env.S3_REGION || 'us-east-1',
  }
}

function isPathStyleEndpoint(endpoint: string): boolean {
  // MinIO / 自定义 endpoint 一般走 path-style；阿里云虚拟主机风格 endpoint 含 oss-
  return !(
    endpoint.includes('.aliyuncs.com') ||
    endpoint.includes('.amazonaws.com')
  )
}

/** 是否为仅本机可访问的存储（浏览器无法匿名读） */
export function isLocalStorageEndpoint(endpoint?: string): boolean {
  const ep = endpoint || process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || ''
  return (
    ep.includes('127.0.0.1') ||
    ep.includes('localhost') ||
    ep.includes('[::1]')
  )
}

/** 创建 S3 兼容客户端 */
export function createS3Client(config?: Partial<StorageConfig>): S3Client {
  const finalConfig = { ...getStorageConfig(), ...config }

  return new S3Client({
    region: finalConfig.region,
    endpoint: finalConfig.endpoint,
    forcePathStyle: isPathStyleEndpoint(finalConfig.endpoint),
    credentials: {
      accessKeyId: finalConfig.accessKey,
      secretAccessKey: finalConfig.secretKey,
    },
  })
}

/** @deprecated 保留兼容旧调用；新代码请用 createS3Client */
export function createStorageClient(config?: Partial<StorageConfig>) {
  return createS3Client(config)
}

let publicPolicyEnsured = false

/** 为 MinIO 桶设置公开读策略，便于浏览器直接访问对象 URL */
export async function ensureBucketPublicRead(): Promise<void> {
  if (publicPolicyEnsured) return

  const config = getStorageConfig()
  // 仅对本机 MinIO 自动放开；云厂商 OSS 通常另有控制台策略
  if (!isLocalStorageEndpoint(config.endpoint)) {
    publicPolicyEnsured = true
    return
  }

  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PublicReadGetObject',
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${config.bucket}/*`],
      },
    ],
  }

  try {
    const client = createS3Client()
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: config.bucket,
        Policy: JSON.stringify(policy),
      })
    )
    publicPolicyEnsured = true
    logger.info('MinIO bucket public-read policy applied', { bucket: config.bucket })
  } catch (err) {
    logger.warn('Failed to set MinIO public-read policy', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 上传文件 */
export async function uploadFile(
  key: string,
  data: Buffer | Blob | File,
  contentType?: string
): Promise<string> {
  const config = getStorageConfig()
  const objectKey = normalizeObjectKey(key)
  const buffer = data instanceof Buffer ? data : Buffer.from(await (data as Blob).arrayBuffer())
  const size = buffer.length

  logger.info('Uploading file', { key: objectKey, size, contentType, endpoint: config.endpoint })

  try {
    const client = createS3Client()
    await ensureBucketPublicRead()
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
      })
    )

    const url = getPublicUrl(objectKey)
    logger.info('File uploaded successfully', { key: objectKey, size, url: url.substring(0, 120) })
    return url
  } catch (err) {
    logger.error('Upload failed', err)
    throw Errors.StorageError(`文件上传失败: ${objectKey}`)
  }
}

/** 用凭证从对象存储读取文件 */
export async function getObjectBuffer(key: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const config = getStorageConfig()
  const objectKey = normalizeObjectKey(key)
  try {
    const client = createS3Client()
    const result = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
      })
    )
    const bytes = await result.Body?.transformToByteArray()
    if (!bytes) return null
    return {
      buffer: Buffer.from(bytes),
      contentType: result.ContentType || guessContentType(objectKey),
    }
  } catch (err) {
    logger.warn('getObjectBuffer failed', {
      key: objectKey,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function guessContentType(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  return 'application/octet-stream'
}

/** 下载文件（支持 http(s) URL 或 storage key） */
export async function downloadFile(urlOrKey: string): Promise<Buffer> {
  logger.info('Downloading file', { url: urlOrKey })

  try {
    // 本机 MinIO 直链可能 403，优先按 key 用凭证读取
    const localKey = extractStorageKeyFromUrl(urlOrKey)
    if (localKey && isLocalStorageEndpoint()) {
      const obj = await getObjectBuffer(localKey)
      if (obj) return obj.buffer
    }

    if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://')) {
      const response = await fetch(urlOrKey)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return Buffer.from(await response.arrayBuffer())
    }

    const obj = await getObjectBuffer(urlOrKey)
    if (!obj) {
      throw new Error('object not found')
    }
    return obj.buffer
  } catch (err) {
    logger.error('Download failed', err)
    throw Errors.StorageError(`文件下载失败: ${urlOrKey}`)
  }
}

/** 从 MinIO/S3 URL 提取 object key */
export function extractStorageKeyFromUrl(url: string): string | null {
  if (!url) return null
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    // 已是 key 或站内路径
    if (url.startsWith('/api/images')) {
      try {
        const u = new URL(url, 'http://localhost')
        return u.searchParams.get('key')
      } catch {
        return null
      }
    }
    if (url.startsWith('/')) return null
    return normalizeObjectKey(url)
  }

  try {
    const u = new URL(url)
    const bucket = process.env.S3_BUCKET || 'drama-studio'
    let pathname = u.pathname.replace(/^\/+/, '')
    if (pathname.startsWith(`${bucket}/`)) {
      pathname = pathname.slice(bucket.length + 1)
    }
    return pathname ? normalizeObjectKey(pathname) : null
  } catch {
    return null
  }
}

/** 生成存储 Key */
export function generateKey(type: 'character' | 'scene' | 'video' | 'audio', id: string, variant?: string): string {
  const prefix = `${type}s/${id}`
  const timestamp = Date.now()

  switch (type) {
    case 'character':
      return `${prefix}/${variant || 'reference'}_${timestamp}.png`
    case 'scene':
      return `${prefix}/image_${timestamp}.png`
    case 'video':
      return `${prefix}/video_${timestamp}.mp4`
    case 'audio':
      return `${prefix}/audio_${timestamp}.mp3`
    default:
      return `${prefix}/file_${timestamp}`
  }
}

/**
 * 获取浏览器可访问的图片 URL。
 * 本机 MinIO 默认私有，返回应用代理地址，避免 403。
 */
export function getPublicUrl(key: string): string {
  const objectKey = normalizeObjectKey(key)

  if (isLocalStorageEndpoint()) {
    return `/api/images?key=${encodeURIComponent(objectKey)}`
  }

  const config = getStorageConfig()
  const endpoint = (process.env.S3_PUBLIC_ENDPOINT || config.endpoint).replace(/\/$/, '')
  const endpointHasBucket = endpoint.includes(config.bucket)

  if (endpointHasBucket) {
    return `${endpoint}/${objectKey}`
  }
  return `${endpoint}/${config.bucket}/${objectKey}`
}

/**
 * 将可能指向本机 MinIO 的 URL 转成可展示的地址（代理或原样）
 */
export function toDisplayImageUrl(urlOrKey: string | null | undefined): string | null {
  if (!urlOrKey) return null
  const trimmed = urlOrKey.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('/api/images') || trimmed.startsWith('data:')) {
    return trimmed
  }

  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed
  }

  const key = extractStorageKeyFromUrl(trimmed)
  if (key && (isLocalStorageEndpoint() || trimmed.includes('127.0.0.1') || trimmed.includes('localhost'))) {
    return `/api/images?key=${encodeURIComponent(key)}`
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }

  return `/api/images?key=${encodeURIComponent(normalizeObjectKey(trimmed))}`
}
