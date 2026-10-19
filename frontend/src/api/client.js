/**
 * HTTP 客户端 + 上传约束（前端访问后端 FastAPI 的唯一入口）
 * ---------------------------------------------------------------------------
 * 设计目标：
 *   1. 所有网络请求都从这里出去，baseURL / 超时 / 错误格式只维护一份；
 *   2. 后端返回的错误是 FastAPI 的 { "detail": "中文提示" }，而 axios 默认会把
 *      它包在 error.response.data 里，业务组件要写一堆 if 才能取到文案。
 *      这里统一转成一个 Error(message)，组件里 catch 完直接展示 e.message 即可；
 *   3. 5MB 上传上限是「前端第一道校验」：后端 router/api.py 并未限制请求体大小，
 *      所以在选择文件 / 抓帧的阶段就要拦下来，避免把十几 MB 的图发给后端做无用推理。
 *
 * 注意：后端代码不允许改动，因此这里的约束常量必须与后端接口语义保持一致，
 *      不要在组件里另写一份魔数，一律从本文件 import。
 */
import axios from 'axios'

/* =========================================================================
 * 一、上传约束常量（前端校验的唯一真源）
 * ========================================================================= */

/**
 * 单张图片允许的最大体积：5MB。
 * 换算说明：1MB = 1024 * 1024 字节，所以 5MB = 5,242,880 字节。
 * 这里用 1024 进制而不是 1000 进制，与文件管理器显示的「MB」一致。
 */
export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024

/** 给界面展示用的可读文案，避免各处硬编码 '5MB' */
export const MAX_UPLOAD_SIZE_LABEL = '5MB'

/**
 * 允许上传的图片 MIME 类型。
 * OpenCV 的 imdecode 实际能解更多格式，但浏览器端只对常见格式做前置提示，
 * 真正的「能不能解」仍以后端返回 400 为准（例如损坏文件）。
 */
export const ACCEPTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/bmp', 'image/webp']

/** <input type="file"> 的 accept 属性值，直接绑定即可 */
export const ACCEPT_ATTR = ACCEPTED_IMAGE_MIME.join(',')

/* =========================================================================
 * 二、通用工具函数
 * ========================================================================= */

/**
 * 把字节数格式化成人类可读的大小。
 * @param {number} bytes 字节数
 * @returns {string} 例如 "512.0 KB"、"3.42 MB"
 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const kb = bytes / 1024
  if (kb < 1) return `${bytes} B`
  const mb = kb / 1024
  if (mb < 1) return `${kb.toFixed(1)} KB`
  return `${mb.toFixed(2)} MB`
}

/**
 * 估算 Base64 字符串解码后的真实字节数。
 * 原理：Base64 每 4 个字符表示 3 字节，末尾可能有 1~2 个 '=' 填充需要扣掉。
 * 摄像头抓帧走的是 /api/recognize/frame（JSON 传 Base64），
 * 没有 File 对象可用 file.size，必须靠这个函数判断是否超过 5MB。
 * @param {string} base64 纯 Base64 字符串（不含 data:image/jpeg;base64, 前缀）
 * @returns {number} 估算字节数
 */
export function estimateBase64Bytes(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return 0
  // 去掉可能存在的 data URL 前缀，只留荷载部分
  const payload = base64.includes(',') ? base64.split(',', 2)[1] : base64
  // 统计末尾的 '=' 填充（最多 2 个）
  let padding = 0
  for (let i = payload.length - 1; i >= 0 && payload[i] === '='; i -= 1) padding += 1
  return Math.floor((payload.length * 3) / 4) - padding
}

/**
 * 校验待上传的图片文件（体积 + 类型）。
 * @param {File|null|undefined} file 用户选择的文件
 * @param {number} [maxSize] 体积上限，默认 5MB
 * @returns {string|null} 校验通过返回 null；不通过返回可直接展示的中文提示
 */
export function validateImageFile(file, maxSize = MAX_UPLOAD_SIZE) {
  if (!file) return '请先选择一个图片文件'

  // 1. 类型校验：有些系统里从剪贴板拖进来的文件 type 为空，用后缀再兜一次
  const hasValidMime = ACCEPTED_IMAGE_MIME.includes(file.type)
  const hasValidExt = /\.(jpe?g|png|bmp|webp)$/i.test(file.name || '')
  if (!hasValidMime && !hasValidExt) {
    return `文件格式不支持，请上传 ${ACCEPTED_IMAGE_MIME.map((m) => m.replace('image/', '')).join(' / ')} 格式的图片`
  }

  // 2. 体积校验（本题核心约束：单张图片不得超过 5MB）
  if (file.size > maxSize) {
    return `图片体积 ${formatFileSize(file.size)} 超过上限 ${MAX_UPLOAD_SIZE_LABEL}，请压缩后再上传`
  }

  // 3. 空文件兜底：0 字节图片后端 imdecode 一定失败，提前拦掉
  if (file.size === 0) {
    return '图片内容为空（0 字节），请重新选择文件'
  }

  return null
}

/**
 * 校验摄像头抓帧得到的 Base64 字符串体积。
 * @param {string} base64 纯 Base64（可带 data URL 前缀）
 * @param {number} [maxSize] 体积上限，默认 5MB
 * @returns {string|null} 通过返回 null，否则返回提示文案
 */
export function validateBase64Frame(base64, maxSize = MAX_UPLOAD_SIZE) {
  if (typeof base64 !== 'string' || base64.length === 0) return '当前帧为空，请重新抓取'
  const bytes = estimateBase64Bytes(base64)
  if (bytes > maxSize) {
    return `当前帧约 ${formatFileSize(bytes)}，超过 ${MAX_UPLOAD_SIZE_LABEL} 上限，请降低采集分辨率后重试`
  }
  return null
}

/* =========================================================================
 * 三、axios 实例
 * ========================================================================= */

/**
 * 后端地址。
 * 开发环境保持 ''：请求发到当前源（http://localhost:5173/api/xxx），
 * 由 vite.config.js 的 proxy 转发到 127.0.0.1:8000，浏览器视角同源、无 CORS。
 * 生产构建时可设置 VITE_API_BASE_URL 直连后端地址。
 */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

const http = axios.create({
  baseURL: API_BASE_URL,
  /**
   * 超时时间给到 180 秒：
   * FaceNet 模型（InceptionResnetV1）首次推理前要加载/下载权重，
   * 再加上 Haar 检测 + 多张人脸逐张比对，慢机器上单次请求几十秒是正常的。
   * 设置超时只是为了在真正卡死时能给出明确提示，而不是无限等待。
   */
  timeout: 180000,
  // 不设置全局 Content-Type：FormData 必须让浏览器自动补 boundary
})

/**
 * 把 FastAPI / 网络层的错误统一转成「可直接展示的中文 Error」。
 * @param {import('axios').AxiosError} error
 * @returns {Error}
 */
function toFriendlyError(error) {
  // 1. 请求被主动取消（例如组件卸载），不当作错误提示
  if (axios.isCancel?.(error)) {
    return new Error('请求已取消')
  }

  // 2. 超时
  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    return new Error('请求超时：后端推理耗时过长，请稍后重试或减少图片中人脸数量')
  }

  // 3. 完全没拿到响应 —— 后端没启动 / 端口不对 / 代理失败
  if (!error.response) {
    return new Error(
      '无法连接后端服务。请确认 FastAPI 已在 8000 端口启动：uvicorn app:app --host 127.0.0.1 --port 8000'
    )
  }

  // 4. 拿到了 HTTP 响应：优先取 FastAPI 的 detail 字段
  const { status, data } = error.response
  const detail = data?.detail

  if (typeof detail === 'string' && detail.trim()) {
    return new Error(detail)
  }

  // FastAPI 的 422 参数校验错误 detail 是一个数组，拼成一句话
  if (Array.isArray(detail)) {
    const text = detail
      .map((item) => item?.msg || JSON.stringify(item))
      .filter(Boolean)
      .join('；')
    if (text) return new Error(`请求参数有误：${text}`)
  }

  // 兜底：按状态码给出通用说明
  if (status === 404) return new Error('接口不存在（404），请确认后端路由前缀是 /api')
  if (status === 413) return new Error('上传内容过大，请压缩图片后重试')
  if (status >= 500) return new Error(`后端内部错误（HTTP ${status}），请查看 uvicorn 控制台日志`)

  return new Error(`请求失败（HTTP ${status}）`)
}

/**
 * 响应拦截器：
 *   - 成功：直接把 data 交给调用方，省掉到处写 res.data；
 *   - 失败：转成带中文 message 的 Error 再 reject。
 */
http.interceptors.response.use(
  (response) => response.data,
  (error) => Promise.reject(toFriendlyError(error))
)

export default http
