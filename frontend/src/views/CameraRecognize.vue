<script setup>
/**
 * CameraRecognize.vue —— 模块二：摄像头实时识别（Base64 帧）
 * ---------------------------------------------------------------------------
 * 对应后端接口：POST /api/recognize/frame?threshold=0.6
 *   请求体 JSON：{ "image_base64": "data:image/jpeg;base64,...." }
 *   返回：{ faces_detected, results: [{ bbox:[x,y,w,h], name, similarity }] }
 *
 * 与图片上传模块的差别：
 *   1. 摄像头没有 File 对象，只能把 canvas 的 toDataURL() 放进 JSON body；
 *   2. Base64 没有 file.size，5MB 上限要用 estimateBase64Bytes() 反推；
 *   3. 该接口返回的 bbox 是数组 [x,y,w,h]（upload 是对象），
 *      已由 api/face.js 的 normalizeBbox() 抹平，组件只处理 {x,y,w,h}。
 *
 * 浏览器权限：getUserMedia 要求安全上下文（https 或 localhost）。
 *
 * 本次视觉优化：
 *   - 取景框未开启时用 16:9 占位 + 居中提示，不再出现高度塌陷或黑块；
 *   - 控制区做成一条工具栏：开启/关闭用图标按钮，主操作「拍照并识别」保持实心主色；
 *   - 抓帧参数与实时统计改为紧凑两列 / 三块布局，扫读更顺；
 *   - 图标统一为 AppIcon。
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

import AppIcon from '../components/AppIcon.vue'
import ResultTable from '../components/ResultTable.vue'
import {
  MAX_UPLOAD_SIZE,
  MAX_UPLOAD_SIZE_LABEL,
  estimateBase64Bytes,
  formatFileSize,
  validateBase64Frame,
} from '../api/client'
import { DEFAULT_THRESHOLD, recognizeFrame } from '../api/face'

/** 连续识别抓帧间隔（毫秒）：够实时，又不给后端排队 */
const AUTO_INTERVAL_MS = 1200

/** 单帧 JPEG 压缩质量默认值 */
const DEFAULT_QUALITY = 0.8

/* ===================== DOM 引用 ===================== */

/** <video>：既用于预览，也是抓帧的绘制源 */
const videoRef = ref(null)

/**
 * 抓帧用的离屏 canvas。
 * 复用同一个节点而不是每次 createElement：连续识别时每秒创建一次 canvas
 * 会造成内存抖动，复用后只是重设宽高 + drawImage。
 */
let canvasEl = null

/* ===================== 状态 ===================== */

/** 摄像头是否已打开 */
const streaming = ref(false)
/** 是否开启连续识别 */
const autoMode = ref(false)
/** 是否有请求在飞（同一时刻只允许一个，避免请求堆积） */
const busy = ref(false)
/** 错误提示 */
const errorMsg = ref('')
/** 普通提示 */
const infoMsg = ref('')
/** 相似度阈值 */
const threshold = ref(DEFAULT_THRESHOLD)
/** JPEG 压缩质量 0.5 ~ 0.95 */
const quality = ref(DEFAULT_QUALITY)
/** 最近一次识别结果 */
const result = ref(null)
/** 最近一帧的体积与分辨率 */
const frameInfo = ref({ bytes: 0, width: 0, height: 0 })
/** 单次识别耗时 */
const elapsedMs = ref(0)
/** 视频原始分辨率，人脸框按它换算百分比 */
const videoSize = ref({ w: 0, h: 0 })
/** 累计识别帧数 */
const frameCount = ref(0)

/** MediaStream 句柄，卸载时必须 stop()，否则摄像头指示灯一直亮 */
let mediaStream = null
/** 连续识别定时器 */
let loopTimer = null

/* ===================== 派生状态 ===================== */

/** 当前帧体积占 5MB 的百分比 */
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
  frameInfo.value.width ? `${frameInfo.value.width}×${frameInfo.value.height}` : '—'
)

/* ===================== 摄像头开关 ===================== */

/**
 * 打开摄像头。
 * getUserMedia 的常见失败原因都翻译成中文，否则浏览器原生报错对使用者毫无帮助。
 */
async function startCamera() {
  errorMsg.value = ''
  infoMsg.value = ''

  if (!navigator.mediaDevices?.getUserMedia) {
    errorMsg.value =
      '当前浏览器不支持摄像头访问，或页面不是安全上下文。请用 http://localhost:5173 访问（本地 localhost 属于安全上下文）'
    return
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    })

    await nextTick()
    const video = videoRef.value
    if (!video) {
      errorMsg.value = '视频元素初始化失败，请刷新页面重试'
      stopCamera()
      return
    }

    video.srcObject = mediaStream
    try {
      await video.play()
    } catch {
      /* 静音视频一般可自动播放，失败时手动抓拍仍可用 */
    }

    streaming.value = true
    infoMsg.value = '摄像头已开启'
  } catch (e) {
    const name = e?.name || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      errorMsg.value = '摄像头权限被拒绝：请点地址栏左侧的锁图标，把摄像头权限改为「允许」后重试'
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
  stopAutoLoop()

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }

  if (videoRef.value) videoRef.value.srcObject = null

  streaming.value = false
  frameInfo.value = { bytes: 0, width: 0, height: 0 }
  videoSize.value = { w: 0, h: 0 }
}

/* ===================== 抓帧 ===================== */

/**
 * 从当前视频画面抓一帧，返回 JPEG 的 data URL。
 * @returns {string|null} 画面未就绪返回 null
 */
function grabFrame() {
  const video = videoRef.value
  // videoWidth 为 0 表示元数据还没加载完，此时抓帧只会得到空白图
  if (!video || !video.videoWidth || !video.videoHeight) return null

  if (!canvasEl) canvasEl = document.createElement('canvas')
  canvasEl.width = video.videoWidth
  canvasEl.height = video.videoHeight

  const ctx = canvasEl.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(video, 0, 0, canvasEl.width, canvasEl.height)

  // 选 JPEG 而不是 PNG：同画质体积小一个量级，是单帧稳在 5MB 内的关键
  return canvasEl.toDataURL('image/jpeg', quality.value)
}

/* ===================== 识别（单次 / 连续） ===================== */

/**
 * 抓一帧并调用 /api/recognize/frame。
 * @param {{silent?: boolean}} [options]
 *   silent=true 用于连续识别：瞬时问题不弹错误，避免每秒闪一次红条
 */
async function recognizeCurrentFrame({ silent = false } = {}) {
  if (busy.value) return

  if (!streaming.value) {
    if (!silent) errorMsg.value = '请先开启摄像头'
    return
  }

  const dataUrl = grabFrame()
  if (!dataUrl) {
    if (!silent) errorMsg.value = '画面尚未就绪，请等摄像头出画后再试'
    return
  }

  // 5MB 校验：Base64 没有 file.size，用长度反推真实字节数
  frameInfo.value = {
    bytes: estimateBase64Bytes(dataUrl),
    width: videoRef.value?.videoWidth || 0,
    height: videoRef.value?.videoHeight || 0,
  }
  videoSize.value = { w: frameInfo.value.width, h: frameInfo.value.height }

  const sizeErr = validateBase64Frame(dataUrl)
  if (sizeErr) {
    errorMsg.value = sizeErr
    if (autoMode.value) stopAutoLoop()
    return
  }

  busy.value = true
  errorMsg.value = ''
  const startedAt = performance.now()
  try {
    result.value = await recognizeFrame(dataUrl, threshold.value)
    elapsedMs.value = Math.round(performance.now() - startedAt)
    frameCount.value += 1
    if (!silent) infoMsg.value = '识别完成'
  } catch (e) {
    errorMsg.value = e.message || '识别失败'
  } finally {
    busy.value = false
  }
}

/**
 * 连续识别：递归 setTimeout 而不是 setInterval。
 * setInterval 不管上一次请求是否结束都会到点触发，后端慢时请求会越堆越多；
 * 递归保证「上一次结束 → 等一会 → 下一次」。
 */
function scheduleNextLoop() {
  if (!autoMode.value || !streaming.value) return
  loopTimer = setTimeout(async () => {
    await recognizeCurrentFrame({ silent: true })
    scheduleNextLoop()
  }, AUTO_INTERVAL_MS)
}

function startAutoLoop() {
  if (!streaming.value) {
    errorMsg.value = '请先开启摄像头'
    return
  }
  errorMsg.value = ''
  autoMode.value = true
  infoMsg.value = `连续识别中，每 ${AUTO_INTERVAL_MS} ms 一帧`
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

function toggleAuto() {
  if (autoMode.value) {
    stopAutoLoop()
    infoMsg.value = '连续识别已停止'
  } else {
    startAutoLoop()
  }
}

function resetThreshold() {
  threshold.value = DEFAULT_THRESHOLD
}

/* ===================== 人脸框叠加 ===================== */

/**
 * 视频像素坐标 → 容器百分比。
 * video 是 width:100% / height:auto，宽高比与 videoWidth:videoHeight 一致，
 * 所以百分比定位在任何屏宽下都对齐。
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
 * 不能用 CSS 尺寸当坐标系 —— 显示尺寸是缩放后的，而后端 bbox 用原始像素。
 */
function onVideoMeta() {
  const video = videoRef.value
  if (!video) return
  videoSize.value = { w: video.videoWidth || 0, h: video.videoHeight || 0 }
}

/**
 * 组件卸载：清定时器 + 停所有轨道 + 丢 canvas 引用。
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
          <div class="card-title">
            <AppIcon name="camera" :size="18" />
            摄像头取景
          </div>
          <p class="card-desc">
            canvas 抓帧 → JPEG Base64 → <code>/api/recognize/frame</code>；单帧同样受
            {{ MAX_UPLOAD_SIZE_LABEL }} 上限约束
          </p>
        </div>
        <span class="badge" :class="streaming ? 'badge-ok' : 'badge-neutral'">
          <i class="status-dot" :class="streaming ? 'on' : 'off'" aria-hidden="true"></i>
          {{ streaming ? '运行中' : '未开启' }}
        </span>
      </div>

      <!--
        取景框。video 始终渲染（保证 ref 可绑定），未开启时用遮罩盖住。
        特意不对 video 做 CSS 镜像：镜像只翻转画面，而 bbox 是原始坐标，
        会导致框与脸左右错位。
      -->
      <div class="stage" :class="{ 'stage-idle': !streaming }">
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

        <!-- 未开启遮罩 -->
        <div v-if="!streaming" class="stage-mask">
          <span class="mask-icon"><AppIcon name="camera" :size="26" /></span>
          <p class="mask-title">摄像头未开启</p>
          <p class="mask-sub">首次使用浏览器会询问权限，请选择「允许」</p>
        </div>

        <!-- 识别中角标 -->
        <span v-if="busy" class="busy-chip">
          <span class="spinner" aria-hidden="true"></span>
          识别中
        </span>
      </div>

      <!-- 控制工具栏 -->
      <div class="controls">
        <button
          v-if="!streaming"
          type="button"
          class="btn"
          @click="startCamera"
        >
          <AppIcon name="play" :size="14" />
          开启摄像头
        </button>
        <button v-else type="button" class="btn" @click="stopCamera">
          <AppIcon name="stop" :size="14" />
          关闭
        </button>

        <button
          type="button"
          class="btn btn-primary capture-btn"
          :disabled="!canCapture"
          @click="recognizeCurrentFrame()"
        >
          <AppIcon name="shutter" :size="16" />
          拍照并识别
        </button>

        <button
          type="button"
          class="btn"
          :class="{ 'btn-active': autoMode }"
          :disabled="!streaming"
          @click="toggleAuto"
        >
          <AppIcon name="repeat" :size="15" />
          {{ autoMode ? '停止连续' : '连续识别' }}
        </button>
      </div>

      <hr class="card-divider" />

      <!-- 参数：两列自适应，窄屏自动单列 -->
      <div class="params">
        <div class="param">
          <div class="row-between param-head">
            <label class="label" for="quality">JPEG 质量</label>
            <span class="value-chip">{{ quality.toFixed(2) }}</span>
          </div>
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
        </div>

        <div class="param">
          <div class="row-between param-head">
            <label class="label" for="cam-threshold">相似度阈值</label>
            <span class="value-chip">{{ threshold.toFixed(2) }}</span>
          </div>
          <input
            id="cam-threshold"
            v-model.number="threshold"
            class="range"
            type="range"
            min="0.3"
            max="0.95"
            step="0.01"
          />
        </div>
      </div>

      <p class="hint params-hint">
        质量越高画面越清晰，但单帧体积越大。
        <button type="button" class="link-btn" @click="resetThreshold">阈值恢复默认</button>
      </p>

      <!-- 实时统计 -->
      <div class="stats">
        <div class="stat-block">
          <span class="stat-key">当前帧体积</span>
          <span class="stat-val">
            {{ frameSizeText }}
            <span class="stat-sub">/ {{ MAX_UPLOAD_SIZE_LABEL }}</span>
          </span>
        </div>
        <div class="stat-block">
          <span class="stat-key">分辨率</span>
          <span class="stat-val">{{ resolutionText }}</span>
        </div>
        <div class="stat-block">
          <span class="stat-key">已识别帧数</span>
          <span class="stat-val">{{ frameCount }}</span>
        </div>
      </div>

      <!-- 帧体积进度条：只在抓过帧之后显示。
           没有数据时渲染一条空轨道，视觉上会被误认成一条滚动条 -->
      <div
        v-if="frameInfo.bytes > 0"
        class="bar frame-bar"
        role="progressbar"
        :aria-valuenow="framePercent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span
          class="bar-fill"
          :class="framePercent >= 100 ? 'bar-danger' : framePercent >= 80 ? 'bar-warn' : 'bar-ok'"
          :style="{ width: `${framePercent}%` }"
        ></span>
      </div>

      <div v-if="errorMsg" class="alert alert-err alert-gap" role="alert">
        <AppIcon name="alert" :size="15" />
        <span>{{ errorMsg }}</span>
      </div>
      <div v-else-if="infoMsg" class="alert alert-info alert-gap">
        <AppIcon name="info" :size="15" />
        <span>{{ infoMsg }}</span>
      </div>
    </section>

    <!-- ==================== 右：结果 ==================== -->
    <section class="card card-stretch">
      <div class="card-head">
        <div class="card-title">
          <AppIcon name="scan-face" :size="18" />
          识别结果
        </div>
        <span v-if="elapsedMs > 0" class="badge badge-neutral">
          <AppIcon name="clock" :size="12" />
          {{ elapsedMs }} ms
        </span>
      </div>

      <!-- card-fill：占满头部以下空间，让空态/加载态垂直居中 -->
      <div class="card-fill">
        <div v-if="busy && !result" class="loading">
          <span class="spinner" aria-hidden="true"></span>
          正在检测并比对特征库……
        </div>

        <div v-else-if="!result" class="empty">
          <span class="empty-mark"><AppIcon name="empty-target" :size="22" /></span>
          <p class="empty-title">等待识别</p>
          <p class="hint">开启摄像头后点「拍照并识别」，或直接开启「连续识别」</p>
        </div>

        <ResultTable v-else :results="result.results" :threshold="threshold" />
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ---------- 状态点 ---------- */
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.status-dot.on {
  background: #16a34a;
  /* 运行中用呼吸动画提示"活的" */
  animation: pulse 1.6s ease-in-out infinite;
}

.status-dot.off {
  background: var(--faint);
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* ---------- 取景框 ---------- */
.stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-md);
  overflow: hidden;
  background: #0b1220;
}

/* 未开启时撑出 16:9，避免卡片高度塌陷甚至抖动 */
.stage-idle {
  aspect-ratio: 16 / 9;
}

.feed {
  display: block;
  width: 100%;
  height: auto;
  background: #0b1220;
}

.stage-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 16px;
  /* 细斜纹底纹：暗示"这里还没有画面"，比纯色更有质感且不抢注意力 */
  background-color: #101a2c;
  background-image: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.028) 0 10px, transparent 10px 20px);
  text-align: center;
}

.mask-icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin-bottom: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.05);
  color: #93a3bb;
}

.mask-title {
  color: #dbe3ef;
  font-size: 14.5px;
  font-weight: 550;
}

.mask-sub {
  color: #7f8ea8;
  font-size: 12.5px;
}

/* 识别中角标 */
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
  font-size: 12.5px;
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
  top: -22px;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
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

/* ---------- 控制栏 ---------- */
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

/* 主操作占剩余宽度，视觉重心落在"拍照并识别" */
.capture-btn {
  flex: 1;
  min-width: 140px;
  height: 40px;
}

/* 连续识别进行中：淡主色底提示"正在跑" */
.btn-active {
  border-color: #c7d2fe;
  background: var(--brand-soft);
  color: var(--brand-dark);
}

/* ---------- 参数 ---------- */
.params {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: 560px) {
  .params {
    grid-template-columns: minmax(0, 1fr);
  }
}

.param-head {
  margin-bottom: 6px;
}

.param-head .label {
  margin-bottom: 0;
}

.params-hint {
  margin-top: 10px;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12.5px;
}

.link-btn:hover {
  text-decoration: underline;
}

/* ---------- 统计 ---------- */
/* 栅格与内部排版复用全局 .stats / .stat-*，这里只补模块自己的间距 */
.stats {
  margin-top: 16px;
}

.frame-bar {
  margin-top: 8px;
}

.alert-gap {
  margin-top: 14px;
}
</style>
