/**
 * 人脸识别业务接口封装
 * ---------------------------------------------------------------------------
 * 本文件与后端 router/api.py 的 5 个接口一一对应，是整个前端唯一「知道接口长什么样」
 * 的地方。组件只调用这里的函数，不直接写 URL，也不直接接触 axios 细节。
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 后端接口清单（前缀 /api，见 router/api.py）                              │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ POST   /api/recognize/upload   multipart: file + Form threshold          │
 * │ POST   /api/recognize/frame    JSON: { image_base64 } + query threshold   │
 * │ POST   /api/register           multipart: file + Form name                │
 * │ GET    /api/features           无参数                                     │
 * │ DELETE /api/features/{name}    路径参数 name                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * 返回值约定：统一包装成 camelCase 的普通对象，方便 Vue 模板直接使用；
 * 后端原始的下划线字段 / 两种 bbox 形态都在这里吃掉，业务组件无需关心。
 */
import http from './client'

/**
 * 相似度阈值默认值。
 * 与后端 recognize_upload / recognize_frame 的 `threshold: float = 0.6` 保持一致，
 * 前端界面上允许用户在 0.3 ~ 0.95 之间调整。
 */
export const DEFAULT_THRESHOLD = 0.6

/**
 * bbox 归一化：把后端两种坐标格式统一成 { x, y, w, h }。
 *
 * 为什么要做这件事：后端两个识别接口返回结构并不一致
 *   - /api/recognize/upload → { "bbox": { "x": 1, "y": 2, "w": 3, "h": 4 } }
 *   - /api/recognize/frame  → { "bbox": [1, 2, 3, 4] }
 * 后端不允许改动，所以在前端这一层抹平差异，绘制人脸框的代码只处理一种形状。
 *
 * @param {object|number[]|null} bbox
 * @returns {{x:number,y:number,w:number,h:number}|null} 无法识别时返回 null
 */
export function normalizeBbox(bbox) {
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const [x, y, w, h] = bbox
    return toBoxNumbers({ x, y, w, h })
  }
  if (bbox && typeof bbox === 'object') {
    return toBoxNumbers(bbox)
  }
  return null
}

/**
 * bbox 内部字段转成合法数字，防止后端返回 null 或字符串导致画框错位。
 * @param {{x:*,y:*,w:*,h:*}} raw
 */
function toBoxNumbers(raw) {
  const x = Number(raw.x)
  const y = Number(raw.y)
  const w = Number(raw.w)
  const h = Number(raw.h)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/**
 * 归一化识别结果列表。
 * 后端每张人脸产生一条：
 *   { bbox, name: string|null, similarity: number|null }
 * 其中 name 为 null 表示「检测到人脸但特征库里没有匹配到人」。
 *
 * @param {object} payload 后端原始响应
 * @returns {{facesDetected:number, results:Array<{bbox:object|null,name:string|null,similarity:number|null,matched:boolean}>}}
 */
export function normalizeRecognizePayload(payload) {
  const rawList = Array.isArray(payload?.results) ? payload.results : []
  const results = rawList.map((item) => {
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name : null
    const similarity = Number.isFinite(Number(item?.similarity)) ? Number(item.similarity) : null
    return {
      bbox: normalizeBbox(item?.bbox),
      name,
      similarity,
      // matched 只表示「是否被判定为某个已录入人员」，与检测是否成功无关
      matched: Boolean(name),
    }
  })

  return {
    // 后端也会返回 faces_detected；若缺失则退回 results 长度，保证界面不出现 NaN
    facesDetected: Number(payload?.faces_detected) || results.length,
    results,
  }
}

/* =========================================================================
 * 接口一：图片上传识别
 * ========================================================================= */

/**
 * 上传一张本地图片进行人脸识别。
 *
 * 对应后端：POST /api/recognize/upload
 *   - file       UploadFile（必填）
 *   - threshold  Form(float)，默认 0.6，相似度低于该值判为 Unknown
 *
 * 注意：这里用 FormData 提交，[file] 与 [threshold] 都走后端 `Form` 声明，
 *      不能把 threshold 放进 query，否则后端收不到会一直用默认 0.6。
 *
 * @param {File} file 已经通过 5MB / 格式校验的图片文件
 * @param {number} [threshold] 相似度阈值 0.3 ~ 0.95
 * @returns {Promise<{facesDetected:number, results:Array}>}
 */
export async function recognizeUpload(file, threshold = DEFAULT_THRESHOLD) {
  const form = new FormData()
  // 字段名必须是 'file'，与后端 `file: UploadFile = File(...)` 的参数名一致
  form.append('file', file, file.name || 'upload.jpg')
  // 后端 threshold 是 Form 字段，必须序列化成字符串
  form.append('threshold', String(threshold))

  const payload = await http.post('/api/recognize/upload', form)
  return normalizeRecognizePayload(payload)
}

/* =========================================================================
 * 接口二：Base64 帧识别（摄像头实时识别走这里）
 * ========================================================================= */

/**
 * 上传一帧 Base64 图片进行识别。
 *
 * 对应后端：POST /api/recognize/frame?threshold=0.6
 *   - body      JSON { "image_base64": "..." }（可带 data URL 前缀，后端会自己切掉）
 *   - threshold query 参数（后端签名是 `def recognize_frame(req: FrameRequest, threshold: float = 0.6)`，
 *               即普通函数参数 → FastAPI 视为 query 参数）
 *
 * @param {string} imageBase64 canvas.toDataURL() 的结果，形如 data:image/jpeg;base64,xxxx
 * @param {number} [threshold] 相似度阈值
 * @returns {Promise<{facesDetected:number, results:Array}>}
 */
export async function recognizeFrame(imageBase64, threshold = DEFAULT_THRESHOLD) {
  const payload = await http.post(
    '/api/recognize/frame',
    // 后端 pydantic 模型定义的是 image_base64（下划线命名），必须原样传
    { image_base64: imageBase64 },
    { params: { threshold } }
  )
  return normalizeRecognizePayload(payload)
}

/* =========================================================================
 * 接口三：人脸录入
 * ========================================================================= */

/**
 * 上传一张人脸图片并绑定姓名，写入特征库。
 *
 * 对应后端：POST /api/register
 *   - file  UploadFile（必填）
 *   - name  Form(str)（必填，姓名不能为空）
 *
 * 后端行为要点（决定了前端的错误提示该怎么写）：
 *   - 一张图只取面积最大的那张人脸录入，避免多脸歧义；
 *   - 检测不到人脸 → 422「未检测到人脸，请更换图片」；
 *   - 同名记录已存在 → 409「已存在特征记录，请先删除再重录」。
 *   两种错误都会由 client.js 统一转成中文 Error.message。
 *
 * @param {File} file 已经通过 5MB / 格式校验的图片文件
 * @param {string} name 姓名（身份标签）
 * @returns {Promise<{recordId:number, name:string}>}
 */
export async function registerFace(file, name) {
  const form = new FormData()
  form.append('file', file, file.name || 'register.jpg')
  form.append('name', name)

  const payload = await http.post('/api/register', form)

  return {
    recordId: Number(payload?.record_id) || null,
    name: payload?.name ?? name,
  }
}

/* =========================================================================
 * 接口四：查看特征库
 * ========================================================================= */

/**
 * 获取特征库全部记录。
 *
 * 对应后端：GET /api/features
 * 返回 { count, items: [{ id, name }] }；特征库为空时后端返回 { count: 0, items: [] }。
 *
 * @returns {Promise<{count:number, items:Array<{id:number,name:string}>}>}
 */
export async function listFeatures() {
  const payload = await http.get('/api/features')
  const items = (Array.isArray(payload?.items) ? payload.items : []).map((item) => ({
    id: Number(item?.id) || 0,
    name: typeof item?.name === 'string' ? item.name : String(item?.name ?? ''),
  }))

  return {
    // 以服务端 count 为准；若缺失则用数组长度兜底
    count: Number.isFinite(Number(payload?.count)) ? Number(payload.count) : items.length,
    items,
  }
}

/* =========================================================================
 * 接口五：按姓名删除特征记录
 * ========================================================================= */

/**
 * 删除某个姓名对应的全部特征记录。
 *
 * 对应后端：DELETE /api/features/{name}
 *   - 库中没有该姓名 → 404「库中没有「xxx」的记录」；
 *   - 成功后返回 { deleted: 删除条数, name }。
 *
 * 姓名里可能含中文、空格、斜杠等字符，必须 encodeURIComponent，
 * 否则 '张 三' 会变成非法 URL，'a/b' 会被当成两个路径段导致 404。
 *
 * @param {string} name 要删除的姓名
 * @returns {Promise<{deleted:number, name:string}>}
 */
export async function deleteFeature(name) {
  const safeName = encodeURIComponent(String(name ?? '').trim())
  const payload = await http.delete(`/api/features/${safeName}`)
  return {
    deleted: Number(payload?.deleted) || 0,
    name: payload?.name ?? name,
  }
}
