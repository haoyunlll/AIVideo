import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import axios from 'axios'

function isTransientNetworkError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : ''
  const message = err instanceof Error ? err.message : String(err)
  return (
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code) ||
    /timeout|ECONNRESET|socket hang up|network/i.test(message)
  )
}

async function axiosDownload(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Connection: 'keep-alive',
    },
    maxRedirects: 10,
    // 不跟随代理环境变量时由调用方控制 process.env
    proxy: false,
  })
  return Buffer.from(response.data)
}

async function fetchDownload(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'image/*,*/*;q=0.8',
    },
  })
  if (!response.ok) {
    throw new Error(`下载失败 HTTP ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 下载文件
 * - 支持 data URI
 * - 对临时 CDN URL 做重试（ECONNRESET 等）
 * - 无代理失败后再尝试保留系统代理（部分海外 CDN 需要代理）
 */
export async function downloadFile(url: string): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma === -1) {
      throw new Error('Invalid data URL')
    }
    const meta = url.slice(0, comma)
    const data = url.slice(comma + 1)
    if (meta.includes(';base64')) {
      return Buffer.from(data, 'base64')
    }
    return Buffer.from(decodeURIComponent(data), 'utf8')
  }

  const savedProxy = {
    http: process.env.HTTP_PROXY || process.env.http_proxy,
    https: process.env.HTTPS_PROXY || process.env.https_proxy,
  }

  const clearProxy = () => {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
  }

  const restoreProxy = () => {
    if (savedProxy.http) {
      process.env.HTTP_PROXY = savedProxy.http
      process.env.http_proxy = savedProxy.http
    }
    if (savedProxy.https) {
      process.env.HTTPS_PROXY = savedProxy.https
      process.env.https_proxy = savedProxy.https
    }
  }

  const maxAttempts = 3
  let lastError: unknown

  try {
    // 先无代理重试，再带代理重试一次链路
    for (const useProxy of [false, true]) {
      if (useProxy && !savedProxy.http && !savedProxy.https) continue

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (useProxy) restoreProxy()
          else clearProxy()

          console.log(
            `[downloadFile] attempt ${attempt}/${maxAttempts} proxy=${useProxy} url=${url.slice(0, 100)}`
          )

          try {
            return await axiosDownload(url)
          } catch (axiosErr) {
            console.warn('[downloadFile] axios failed, try fetch:', axiosErr)
            return await fetchDownload(url)
          }
        } catch (err) {
          lastError = err
          console.warn(`[downloadFile] failed attempt ${attempt} proxy=${useProxy}:`, err)
          if (!isTransientNetworkError(err) && attempt >= 2) {
            break
          }
          await new Promise((r) => setTimeout(r, 800 * attempt))
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`下载图片失败: ${String(lastError)}`)
  } finally {
    restoreProxy()
  }
}

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
