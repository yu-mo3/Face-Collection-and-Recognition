<script setup>
/**
 * CameraRecognize.vue —— 模块二：摄像头实时识别（Base64 帧）
 * ---------------------------------------------------------------------------
 * 对应后端接口：POST /api/recognize/frame?threshold=0.6
 *   请求体 JSON：{ "image_base64": "data:image/jpeg;base64,...." }
 *   返回：{ faces_detected, results: [{ bbox:[x,y,w,h], name, similarity }] }
 *
 * 与模块一（图片上传）的关键差别：
 *   1. 图片上传走 multipart/FormData，摄像头没有 File 对象，只能把 canvas 的
 *      toDataURL() 结果当 Base64 放进 JSON body；
 *   2. Base64 没有 file.size，5MB 上限要用 estimateBase64Bytes() 反推真实字节数；
 *   3. 后端这个接口的 bbox 是数组 [x,y,w,h]（upload 是对象），
 *      src/api/face.js 的 normalizeBbox() 已经抹平，本组件只处理 {x,y,w,h}。
 *
 * 浏览器权限提醒：
 *   navigator.mediaDevices.getUserMedia 要求「安全上下文」——
 *   https:// 或 http://localhost 才允许。用 127.0.0.1 以外的 IP 打开页面会拿不到摄像头。
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

import ResultTable from '../components/ResultTable.vue'
import {
  MAX_UPLOAD_SIZE,
  MAX_UPLOAD_SIZE_LABEL,
  estimateBase64Bytes,
  formatFileSize,
  validateBase64Frame,
} from '../api/client'
import { DEFAULT_THRESHOLD, recognizeFrame } from '../api/face'

/** 连续识别模式下的抓帧间隔（毫秒）。1.2 秒是「够实时」与「不给后端排队」的折中 */
const AUTO_INTERVAL_MS = 1200

/** 单帧 JPEG 压缩质量的默认值。质量越高越清晰，但 Base64 也越大 */
const DEFAULT_QUALITY = 0.8

/* ===================== DOM 引用 ===================== */

/** <video> 元素：既用于预览，也是抓帧的绘制源 */
const videoRef = ref(null)
/**
 * 抓帧用的离屏 canvas。
 * 复用同一个 DOM 节点而不是每次 createElement：连续识别时每秒创建一次 canvas
 * 会造成不必要的内存抖动，复用后只是重设宽高 + drawImage。
 */
let canvasEl = null

/* ===================== 状态 ===================== */

/** 摄像头是否已经打开（MediaStream 是否存在） */
const streaming = ref(false)
/** 是否开启连续识别 */
const autoMode = ref(false)
/** 是否正在等待后端响应（同一时间只允许一个请求在飞，避免请求堆积） */
const busy = ref(false)
/** 错误提示 */
const errorMsg = ref('')
/** 普通提示（例如"已抓拍"） */
const infoMsg = ref('')
/** 相似度阈值 */
const threshold = ref(DEFAULT_THRESHOLD)
/** JPEG 压缩质量 0.5 ~ 0.95 */
const quality = ref(DEFAULT_QUALITY)
/** 最近一次识别结果 { facesDetected, results } */
const result = ref(null)
/** 最近一帧的体积与分辨率信息，用于展示和 5MB 校验反馈 */
const frameInfo = ref({ bytes: 0, width: 0, height: 0 })
/** 单次识别耗时 */
const elapsedMs = ref(0)
/** 视频原始分辨率，人脸框按它换算百分比 */
const videoSize = ref({ w: 0, h: 0 })
/** 累计识别帧数，连续模式下的进度感 */
const frameCount = ref(0)

/** MediaStream 句柄，必须在卸载时 stop()，否则摄像头指示灯一直亮 */
let mediaStream = null
/** 连续识别的定时器句柄 */
let loopTimer = null

/* ===================== 派生状态 ===================== */

/** 当前帧体积占 5MB 上限的百分比 */
const framePercent = computed(() => {
  if (!frameInfo.value.bytes) return 0
  return Math.min(100, Math.round((frameInfo.value.bytes / MAX_UPLOAD_SIZE) * 100))
})

/** 「拍照并识别」是否可用 */
const canCapture = computed(() => streaming.value && !busy.value)

/** 帧体积文案 */
const frameSizeText = computed(() =>
  frameInfo.value.bytes ? formatFileSize(frameInfo.value.bytes) : '—'
)

/** 分辨率文案 */
const resolutionText = computed(() =>
  frameInfo.value.width ? `${frameInfo.value.width} × ${frameInfo.value.height}` : '—'
)

/* ===================== 摄像头开关 ===================== */

/**
 * 打开摄像头。
 * getUserMedia 的常见失败原因都翻译成中文，否则浏览器原生报错对使用者毫无帮助。
 */
async function startCamera() {
  errorMsg.value = ''
  infoMsg.value = ''

  // 1. 前置检查：非安全上下文（非 https / 非 localhost）直接给结论
  if (!navigator.mediaDevices?.getUserMedia) {
    errorMsg.value =
      '当前浏览器不支持摄像头访问，或页面不是安全上下文。请用 http://localhost:5173 访问（本地 localhost 属于安全上下文）'
    return
  }

  try {
    // 2. 申请视频流：720p 理想分辨率，音频一律关闭
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
      },
      audio: false,
    })

    // 3. 等 video 元素渲染好再绑定（首次点击时 ref 已存在，这里 nextTick 是稳妥兜底）
    await nextTick()
    const video = videoRef.value
    if (!video) {
      errorMsg.value = '视频元素初始化失败，请刷新页面重试'
      stopCamera()
      return
    }

    video.srcObject = mediaStream
    // 部分浏览器不会自动播放，显式 play() 一次；自动播放被拒也不影响手动抓帧
    try {
      await video.play()
    } catch {
      /* 忽略：静音视频在绝大多数浏览器可以自动播放，失败时用户点抓拍仍可用 */
    }

    streaming.value = true
    infoMsg.value = '摄像头已开启，点击「拍照并识别」抓取当前画面'
  } catch (e) {
    // 4. 错误分类：权限 / 设备 / 被占用 / 其它
    const name = e?.name || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      errorMsg.value = '摄像头权限被拒绝：请点击地址栏左侧的锁图标，把摄像头权限改为「允许」后重试'
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      errorMsg.value = '未找到可用摄像头设备，请检查设备连接'
    } else if (name === 'NotReadableError' || name === 'AbortError') {
      errorMsg.value = '摄像头被其它程序占用（如微信、腾讯会议），请关闭后重试'
    } else {
      errorMsg.value = `打开摄像头失败：${e?.message || '未知错误'}`
    }
    stopCamera()
  }
}

/** 关闭摄像头并释放硬件资源 */
function stopCamera() {
  // 1. 停掉连续识别，否则定时器会继续调用 grabFrame
  stopAutoLoop()

  // 2. 停止所有轨道：MediaStreamTrack 不 stop 的话摄像头指示灯会一直亮
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }

  // 3. 断开 video 的引用，帮助浏览器回收解码器
  if (videoRef.value) {
    videoRef.value.srcObject = null
  }

  streaming.value = false
  frameInfo.value = { bytes: 0, width: 0, height: 0 }
  videoSize.value = { w: 0, h: 0 }
}

/* ===================== 抓帧 ===================== */

/**
 * 从当前视频画面抓一帧，返回 JPEG 的 data URL。
 * @returns {string|null} 形如 data:image/jpeg;base64,xxxx；画面未就绪返回 null
 */
function grabFrame() {
  const video = videoRef.value
  // videoWidth 为 0 表示元数据还没加载完（刚点开摄像头的瞬间），此时抓帧只会得到空白图
  if (!video || !video.videoWidth || !video.videoHeight) return null

  // 1. 复用离屏 canvas，尺寸与视频原始分辨率一致，
  //    保证后端返回的 bbox 坐标与画面上看到的像素一一对应
  if (!canvasEl) canvasEl = document.createElement('canvas')
  canvasEl.width = video.videoWidth
  canvasEl.height = video.videoHeight

  const ctx = canvasEl.getContext('2d')
  if (!ctx) return null

  // 2. 把当前视频帧画到 canvas 上
  ctx.drawImage(video, 0, 0, canvasEl.width, canvasEl.height)

  // 3. 导出 JPEG。选 image/jpeg 而非 png：同样画质下体积小一个量级，
  //    是让单帧稳稳低于 5MB 的关键；质量由滑块控制
  return canvasEl.toDataURL('image/jpeg', quality.value)
}

/* ===================== 识别（单次 / 连续） ===================== */

/**
 * 抓一帧并调用 /api/recognize/frame。
 * @param {{silent?: boolean}} [options]
 *   silent=true 用于连续识别模式：出现"画面未就绪"这类瞬时问题时不弹错误，
 *   否则每秒闪一次红条，体验很差。
 */
async function recognizeCurrentFrame({ silent = false } = {}) {
  // 1. 同一个时间只允许一个请求在飞。连续模式下间隔 1.2s，
  //    但后端若在 CPU 上跑了 3 秒，不加锁就会堆积请求
  if (busy.value) return

  if (!streaming.value) {
    if (!silent) errorMsg.value = '请先开启摄像头'
    return
  }

  // 2. 抓帧
  const dataUrl = grabFrame()
  if (!dataUrl) {
    if (!silent) errorMsg.value = '画面尚未就绪，请等摄像头出画后再试'
    return
  }

  // 3. 5MB 校验：Base64 没有 file.size，用长度反推真实字节数
  const bytes = estimateBase64Bytes(dataUrl)
  frameInfo.value = {
    bytes,
    width: videoRef.value?.videoWidth || 0,
    height: videoRef.value?.videoHeight || 0,
  }
  videoSize.value = { w: frameInfo.value.width, h: frameInfo.value.height }

  const sizeErr = validateBase64Frame(dataUrl)
  if (sizeErr) {
    errorMsg.value = sizeErr
    // 连续模式下超限就先停下，避免每 1.2 秒报一次同样的错
    if (autoMode.value) stopAutoLoop()
    return
  }

  // 4. 发请求
  busy.value = true
  errorMsg.value = ''
  const startedAt = performance.now()
  try {
    result.value = await recognizeFrame(dataUrl, threshold.value)
    elapsedMs.value = Math.round(performance.now() - startedAt)
    frameCount.value += 1
    if (!silent) infoMsg.value = '识别完成'
  } catch (e) {
    // 连续模式下不要因为一次失败就停掉整个流程，把错误显示出来但继续跑
    errorMsg.value = e.message || '识别失败'
  } finally {
    busy.value = false
  }
}

/**
 * 连续识别：递归 setTimeout 而不是 setInterval。
 * 原因：setInterval 不管上一次请求有没有结束都会到点触发，
 * 后端较慢时会把请求越堆越多；递归 setTimeout 保证「上一次结束 → 等一会 → 下一次」。
 */
function scheduleNextLoop() {
  if (!autoMode.value || !streaming.value) return
  loopTimer = setTimeout(async () => {
    await recognizeCurrentFrame({ silent: true })
    scheduleNextLoop()
  }, AUTO_INTERVAL_MS)
}

/** 开启连续识别 */
function startAutoLoop() {
  if (!streaming.value) {
    errorMsg.value = '请先开启摄像头'
    return
  }
  errorMsg.value = ''
  autoMode.value = true
  infoMsg.value = `连续识别已开启，每 ${AUTO_INTERVAL_MS} ms 抓一帧`
  scheduleNextLoop()
}

/** 停止连续识别（定时器必须清掉，否则组件销毁后仍会在后台发请求） */
function stopAutoLoop() {
  if (loopTimer) {
    clearTimeout(loopTimer)
    loopTimer = null
  }
  autoMode.value = false
}

/** 连续识别按钮：开 / 关 */
function toggleAuto() {
  if (autoMode.value) {
    stopAutoLoop()
    infoMsg.value = '连续识别已停止'
  } else {
    startAutoLoop()
  }
}

/** 阈值恢复默认 */
function resetThreshold() {
  threshold.value = DEFAULT_THRESHOLD
}

/* ===================== 人脸框叠加 ===================== */

/**
 * 视频像素坐标 → 容器百分比。
 * video 元素设成 width:100% / height:auto，宽高比与 videoWidth:videoHeight 完全一致，
 * 所以百分比定位在任何屏幕宽度下都严格对齐。
 * @param {{x:number,y:number,w:number,h:number}|null} bbox
 */
function boxStyle(bbox) {
  const { w, h } = videoSize.value
  if (!bbox || !w || !h) return {}
  return {
    left: `${(bbox.x / w) * 100}%`,
    top: `${(bbox.y / h) * 100}%`,
    width: `${(bbox.w / w) * 100}%`,
    height: `${(bbox.h / h) * 100}%`,
  }
}

/**
 * 视频元数据加载完成：记录真实分辨率。
 * 注意不能用 CSS 尺寸当坐标系 —— video 的显示尺寸是缩放后的，
 * 而后端 bbox 用的是原始像素，两者混用会导致框整体偏移。
 */
function onVideoMeta() {
  const video = videoRef.value
  if (!video) return
  videoSize.value = { w: video.videoWidth || 0, h: video.videoHeight || 0 }
}

/**
 * 组件卸载：
 *   - 清定时器
 *   - 停止所有 MediaStreamTrack（否则切走标签页后摄像头仍被占用）
 *   - 丢引用让 canvas 可回收
 * 这三步缺一不可，是摄像头类组件最常见的资源泄漏点。
 */
onBeforeUnmount(() => {
  stopAutoLoop()
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }
  if (videoRef.value) videoRef.value.srcObject = null
  canvasEl = null
})
</script>

<template>
  <div class="split fade-in">
    <!-- ==================== 左：取景与采集 ==================== -->
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title"><span aria-hidden="true">📷</span> 摄像头实时识别</div>
          <p class="card-desc">
            canvas 抓帧 → JPEG Base64 → <code>/api/recognize/frame</code>；
            单帧同样受 <strong>{{ MAX_UPLOAD_SIZE_LABEL }}</strong> 上限约束
          </p>
        </div>
        <span class="badge" :class="streaming ? 'badge-ok' : 'badge-neutral'">
          {{ streaming ? '已开启' : '未开启' }}
        </span>
      </div>

      <!--
        取景框：video 始终渲染（保证 ref 可绑定），未开启时用遮罩盖住。
        video 不做 CSS 镜像（transform: scaleX(-1)）—— 镜像只会翻转画面，
        而 overlay 里的人脸框用的是后端原始坐标，画面翻转会导致框与脸左右错位。
      -->
      <div class="stage">
        <video
          ref="videoRef"
          class="feed"
          autoplay
          playsinline
          muted
          @loadedmetadata="onVideoMeta"
        ></video>

        <!-- 人脸框叠加层 -->
        <template v-if="streaming && result">
          <template v-for="(item, index) in result.results" :key="index">
            <div
              v-if="item.bbox"
              class="face-box"
              :class="item.matched ? 'hit' : 'miss'"
              :style="boxStyle(item.bbox)"
            >
              <span class="face-box-label">
                {{ item.matched ? item.name : 'Unknown' }}
                <em v-if="item.similarity !== null">{{ item.similarity.toFixed(2) }}</em>
              </span>
            </div>
          </template>
        </template>

        <!-- 未开启时的遮罩 -->
        <div v-if="!streaming" class="stage-mask">
          <div class="stage-mask-icon" aria-hidden="true">🎥</div>
          <p>摄像头未开启</p>
          <p class="hint">首次使用浏览器会询问摄像头权限，请选择「允许」</p>
        </div>

        <!-- 请求进行中的角标，避免用户以为画面卡住 -->
        <span v-if="busy" class="busy-chip">
          <span class="spinner" aria-hidden="true"></span>
          识别中
        </span>
      </div>

      <!-- 控制区 -->
      <div class="row controls">
        <button v-if="!streaming" type="button" class="btn btn-primary" @click="startCamera">
          <span aria-hidden="true">▶</span> 开启摄像头
        </button>
        <button v-else type="button" class="btn" @click="stopCamera">
          <span aria-hidden="true">■</span> 关闭摄像头
        </button>

        <button
          type="button"
          class="btn btn-primary"
          :disabled="!canCapture"
          @click="recognizeCurrentFrame()"
        >
          <span aria-hidden="true">📸</span> 拍照并识别
        </button>

        <button
          type="button"
          class="btn"
          :class="{ 'btn-danger': autoMode }"
          :disabled="!streaming"
          @click="toggleAuto"
        >
          {{ autoMode ? '⏹ 停止连续识别' : '⏱ 连续识别' }}
        </button>
      </div>

      <!-- 抓帧参数 -->
      <div class="field">
        <label class="label" for="quality">
          单帧 JPEG 质量
          <span class="optional">画质越高体积越大，影响 5MB 余量</span>
        </label>
        <div class="row">
          <input
            id="quality"
            v-model.number="quality"
            class="range"
            type="range"
            min="0.5"
            max="0.95"
            step="0.05"
            :disabled="autoMode"
          />
          <span class="mono param-value">{{ quality.toFixed(2) }}</span>
        </div>

        <label class="label param-gap" for="cam-threshold">
          相似度阈值
          <span class="optional">默认 {{ DEFAULT_THRESHOLD }}</span>
        </label>
        <div class="row">
          <input
            id="cam-threshold"
            v-model.number="threshold"
            class="range"
            type="range"
            min="0.3"
            max="0.95"
            step="0.01"
          />
          <span class="mono param-value">{{ threshold.toFixed(2) }}</span>
          <button type="button" class="link-btn" @click="resetThreshold">恢复默认</button>
        </div>
      </div>

      <!-- 5MB 实时余量：每抓一帧都能看到当前帧多大、还剩多少空间 -->
      <div class="frame-stats">
        <div class="row-between">
          <span class="text-muted">当前帧体积</span>
          <span class="mono">
            {{ frameSizeText }}
            <span class="text-muted"> / {{ MAX_UPLOAD_SIZE_LABEL }}</span>
            <strong>（{{ framePercent }}%）</strong>
          </span>
        </div>
        <div class="bar" role="progressbar" :aria-valuenow="framePercent" aria-valuemin="0" aria-valuemax="100">
          <span
            class="bar-fill"
            :class="framePercent >= 100 ? 'bar-danger' : framePercent >= 80 ? 'bar-warn' : 'bar-ok'"
            :style="{ width: `${framePercent}%` }"
          ></span>
        </div>
        <div class="row-between stats-line">
          <span class="text-muted">分辨率 {{ resolutionText }}</span>
          <span class="text-muted">已识别 {{ frameCount }} 帧</span>
        </div>
      </div>

      <div v-if="errorMsg" class="alert alert-err" role="alert">
        <span aria-hidden="true">⚠️</span>
        <span>{{ errorMsg }}</span>
      </div>
      <div v-else-if="infoMsg" class="alert alert-info">
        <span aria-hidden="true">ℹ️</span>
        <span>{{ infoMsg }}</span>
      </div>
    </section>

    <!-- ==================== 右：结果 ==================== -->
    <section class="card">
      <div class="card-head">
        <div class="card-title"><span aria-hidden="true">📋</span> 识别结果</div>
        <span v-if="elapsedMs > 0" class="badge badge-neutral">耗时 {{ elapsedMs }} ms</span>
      </div>

      <div v-if="busy && !result" class="loading">
        <span class="spinner" aria-hidden="true"></span>
        正在检测并比对特征库……
      </div>

      <div v-else-if="!result" class="empty">
        <span class="empty-mark" aria-hidden="true">🫥</span>
        开启摄像头后点击「拍照并识别」或「连续识别」
      </div>

      <template v-else>
        <ResultTable :results="result.results" :threshold="threshold" />
      </template>
    </section>
  </div>
</template>

<style scoped>
/* ---------- 取景框 ---------- */
.stage {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  background: #0b1220;
  /* 未开启时也要有高度，否则遮罩没有任何空间可显示 */
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.feed {
  display: block;
  width: 100%;
  height: auto;
  /* 宽高比跟随视频原始比例，保证 overlay 百分比与像素坐标一一对应 */
  background: #0b1220;
}

/* 未开启时的居中遮罩 */
.stage-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 16px;
  background: repeating-linear-gradient(45deg, #111a2e 0 12px, #0e1626 12px 24px);
  color: #cbd5e1;
  text-align: center;
  font-size: 13px;
}

.stage-mask-icon {
  font-size: 30px;
  line-height: 1;
  opacity: 0.9;
}

.stage-mask .hint {
  color: #94a3b8;
}

/* 识别中的角标 */
.busy-chip {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.82);
  color: #e2e8f0;
  font-size: 12px;
  backdrop-filter: blur(4px);
}

/* ---------- 人脸框 ---------- */
.face-box {
  position: absolute;
  border: 2px solid;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.75) inset;
  pointer-events: none;
}

.face-box.hit {
  border-color: #22c55e;
}

.face-box.miss {
  border-color: #ef4444;
}

.face-box-label {
  position: absolute;
  left: -2px;
  top: -23px;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 4px;
  color: #fff;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.7;
  white-space: nowrap;
}

.face-box-label em {
  font-style: normal;
  font-weight: 400;
  opacity: 0.85;
}

.face-box.hit .face-box-label {
  background: #16a34a;
}

.face-box.miss .face-box-label {
  background: #dc2626;
}

/* ---------- 控件 ---------- */
.controls {
  margin-top: 14px;
}

.param-value {
  min-width: 44px;
  text-align: right;
  font-weight: 600;
  color: var(--brand);
}

.param-gap {
  margin-top: 12px;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  text-decoration: underline;
}

/* ---------- 5MB 余量 ---------- */
.frame-stats {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fbfcfe;
  font-size: 12.5px;
}

.stats-line {
  margin-top: 6px;
}

.bar {
  height: 6px;
  margin-top: 8px;
  border-radius: 999px;
  background: #eef1f6;
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.2s ease, background 0.2s;
}

.bar-ok {
  background: var(--brand);
}
.bar-warn {
  background: var(--warn);
}
.bar-danger {
  background: var(--err);
}
</style>
