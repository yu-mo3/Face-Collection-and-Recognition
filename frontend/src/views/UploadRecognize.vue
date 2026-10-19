<script setup>
/**
 * UploadRecognize.vue —— 模块一：图片上传识别
 * ---------------------------------------------------------------------------
 * 对应后端接口：POST /api/recognize/upload（router/api.py）
 *   multipart 提交：file（图片）+ threshold（Form 字段，相似度阈值，默认 0.6）
 *   返回：{ faces_detected, results: [{ bbox:{x,y,w,h}, name, similarity }] }
 *
 * 本模块的完整交互链路：
 *   选择/拖拽图片 → 前端 5MB + 格式校验 → 本地预览（URL.createObjectURL）
 *   → 点击「开始识别」→ 再次校验（防止阈值/文件被中途改动）→ 调接口
 *   → 在预览图上按原始像素坐标叠加人脸框 → 表格列出每张人脸的判定结果
 *
 * 关于「5MB」的落点（本次需求的核心约束）：
 *   后端 router/api.py 没有限制请求体大小，因此上限完全由前端把关：
 *   - 选中文件的瞬间就校验，超限直接拦下并给出实际体积，不用等上传失败；
 *   - 真正提交前再校验一次（validateImageFile），因为 file 是响应式引用，
 *     理论上存在被其它逻辑替换的可能，双保险成本极低；
 *   - 常量来自 api/client.js 的 MAX_UPLOAD_SIZE，不在本组件里写魔数。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import ResultTable from '../components/ResultTable.vue'
import {
  ACCEPT_ATTR,
  MAX_UPLOAD_SIZE,
  MAX_UPLOAD_SIZE_LABEL,
  formatFileSize,
  validateImageFile,
} from '../api/client'
import { DEFAULT_THRESHOLD, recognizeUpload } from '../api/face'

/* ===================== 状态 ===================== */

/** 当前选中的图片文件（File 对象） */
const file = ref(null)
/** 预览图 URL：URL.createObjectURL 生成，用完必须 revoke，否则内存泄漏 */
const previewUrl = ref('')
/** 预览图的原始像素尺寸，人脸框按它换算成百分比定位 */
const naturalSize = ref({ w: 0, h: 0 })
/** 错误提示（校验失败或接口异常） */
const errorMsg = ref('')
/** 相似度阈值，默认与后端一致 0.6 */
const threshold = ref(DEFAULT_THRESHOLD)
/** 请求进行中 */
const loading = ref(false)
/** 识别结果 { facesDetected, results } */
const result = ref(null)
/** 本次识别耗时（毫秒），给使用者一个性能感知 */
const elapsedMs = ref(0)
/** 拖拽悬停高亮 */
const dragOver = ref(false)

/** 隐藏的原生 file input 引用 */
const fileInputRef = ref(null)

/* ===================== 派生状态 ===================== */

/** 文件大小可读文案 */
const sizeText = computed(() => (file.value ? formatFileSize(file.value.size) : ''))

/**
 * 文件体积占 5MB 上限的比例，用于画一条使用量进度条。
 * 让「5MB」这个限制在界面上是"看得见"的，而不是只在报错时才出现。
 */
const sizePercent = computed(() => {
  if (!file.value) return 0
  return Math.min(100, Math.round((file.value.size / MAX_UPLOAD_SIZE) * 100))
})

/** 体积进度条颜色：超过 80% 变黄提醒，达到 100% 变红 */
const sizeBarClass = computed(() => {
  if (sizePercent.value >= 100) return 'bar-danger'
  if (sizePercent.value >= 80) return 'bar-warn'
  return 'bar-ok'
})

/** 是否已经可以点「开始识别」 */
const canRecognize = computed(() => Boolean(file.value) && !loading.value)

/* ===================== 文件选择与校验 ===================== */

/** 打开系统文件选择框 */
function openPicker() {
  fileInputRef.value?.click()
}

/**
 * 原生 input 的 change 事件
 * 注意：选完文件后要把 input.value 置空，否则连续选同一个文件不会触发 change，
 * 用户会以为按钮失灵（这是 <input type=file> 的经典坑）。
 */
function onFileChange(event) {
  const picked = event.target.files?.[0]
  event.target.value = ''
  if (picked) applyFile(picked)
}

/** 拖拽经过时高亮放置区 */
function onDragOver() {
  dragOver.value = true
}

/** 拖拽离开时取消高亮 */
function onDragLeave() {
  dragOver.value = false
}

/**
 * 放下文件
 * @param {DragEvent} event
 */
function onDrop(event) {
  event.preventDefault()
  dragOver.value = false
  const picked = event.dataTransfer?.files?.[0]
  if (picked) applyFile(picked)
}

/**
 * 接收一个文件：先校验（含 5MB 上限），通过后生成本地预览。
 * @param {File} picked
 */
function applyFile(picked) {
  // 1. 前端校验：类型 / 5MB 体积 / 空文件，任何一条不通过都不进入预览
  const err = validateImageFile(picked)
  if (err) {
    errorMsg.value = err
    return
  }

  // 2. 清理上一轮状态，避免旧结果和新图片错位
  errorMsg.value = ''
  result.value = null
  elapsedMs.value = 0
  revokePreview()

  // 3. 绑定新文件并生成预览；createObjectURL 不读磁盘内容，性能远好于 FileReader
  file.value = picked
  previewUrl.value = URL.createObjectURL(picked)
}

/** 释放预览 URL，防止大图反复选择时内存持续增长 */
function revokePreview() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
}

/** 移除当前图片，回到初始状态 */
function clearFile() {
  revokePreview()
  file.value = null
  result.value = null
  errorMsg.value = ''
  elapsedMs.value = 0
  naturalSize.value = { w: 0, h: 0 }
}

/**
 * 图片加载完成：记录原始像素尺寸。
 * 后端返回的 bbox 是「原图坐标系」下的像素值，而预览图会被 CSS 缩放，
 * 所以必须拿到 naturalWidth / naturalHeight 才能换算成正确的百分比位置。
 */
function onImageLoad(event) {
  naturalSize.value = {
    w: event.target.naturalWidth || 0,
    h: event.target.naturalHeight || 0,
  }
}

/* ===================== 调用识别接口 ===================== */

/**
 * 执行识别。
 * 失败时只把 message 显示到页面，不打 alert —— 用户可以直接改阈值重试。
 */
async function runRecognize() {
  if (!file.value || loading.value) return

  // 提交前二次校验 5MB（见文件头注释）
  const err = validateImageFile(file.value)
  if (err) {
    errorMsg.value = err
    return
  }

  loading.value = true
  errorMsg.value = ''
  result.value = null

  const startedAt = performance.now()
  try {
    // 真实请求：POST /api/recognize/upload（FormData: file + threshold）
    result.value = await recognizeUpload(file.value, threshold.value)
    elapsedMs.value = Math.round(performance.now() - startedAt)
  } catch (e) {
    // client.js 已经把所有错误转成中文 message
    errorMsg.value = e.message || '识别失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

/** 阈值恢复后端默认值 */
function resetThreshold() {
  threshold.value = DEFAULT_THRESHOLD
}

/* ===================== 人脸框叠加计算 ===================== */

/**
 * 把后端返回的像素坐标换成相对预览图的百分比定位。
 * 用百分比而不是绝对像素，是为了让预览图被容器自适应缩放后，
 * 人脸框依然严丝合缝地贴在脸上（窗口拖动大小也不会错位）。
 *
 * @param {{x:number,y:number,w:number,h:number}|null} bbox
 * @returns {object} Vue 内联样式对象；bbox 非法时返回空对象（配合外层 v-if 一起用）
 */
function boxStyle(bbox) {
  const { w, h } = naturalSize.value
  if (!bbox || !w || !h) return {}
  return {
    left: `${(bbox.x / w) * 100}%`,
    top: `${(bbox.y / h) * 100}%`,
    width: `${(bbox.w / w) * 100}%`,
    height: `${(bbox.h / h) * 100}%`,
  }
}

/**
 * 标注文字放在框外上方；如果人脸贴着图片顶部，改放到框内顶部，
 * 否则文字会被裁掉看不见。
 * @param {{y:number}|null} bbox
 */
function labelInside(bbox) {
  return Boolean(bbox) && bbox.y < 26
}

/** 组件卸载时释放预览 URL，避免离开页面后内存不回收 */
onBeforeUnmount(revokePreview)
</script>

<template>
  <div class="split fade-in">
    <!-- ==================== 左：上传与参数 ==================== -->
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title"><span aria-hidden="true">🖼️</span> 上传图片识别</div>
          <p class="card-desc">
            支持 jpg / png / bmp / webp，
            <strong>单张不超过 {{ MAX_UPLOAD_SIZE_LABEL }}</strong>（{{ MAX_UPLOAD_SIZE.toLocaleString() }} 字节）
          </p>
        </div>
      </div>

      <!-- 隐藏的原生 input，由下方放置区代理点击 -->
      <input
        ref="fileInputRef"
        type="file"
        class="sr-only"
        :accept="ACCEPT_ATTR"
        @change="onFileChange"
      />

      <!-- 未选图：展示拖拽放置区 -->
      <div
        v-if="!file"
        class="dropzone"
        :class="{ over: dragOver }"
        role="button"
        tabindex="0"
        aria-label="选择或拖拽图片到此处"
        @click="openPicker"
        @keydown.enter.prevent="openPicker"
        @keydown.space.prevent="openPicker"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop="onDrop"
      >
        <div class="dropzone-icon" aria-hidden="true">⬆️</div>
        <p class="dropzone-title">点击选择图片，或把图片拖到这里</p>
        <p class="dropzone-hint">前端会先校验格式与体积（≤ {{ MAX_UPLOAD_SIZE_LABEL }}）再上传</p>
      </div>

      <!-- 已选图：展示缩略信息 + 体积进度 -->
      <div v-else class="picked">
        <div class="picked-row">
          <span class="picked-name" :title="file.name">{{ file.name }}</span>
          <span class="badge badge-neutral">{{ sizeText }}</span>
        </div>

        <!-- 5MB 使用量进度条：让限制可视化 -->
        <div class="bar" role="progressbar" :aria-valuenow="sizePercent" aria-valuemin="0" aria-valuemax="100">
          <span class="bar-fill" :class="sizeBarClass" :style="{ width: `${sizePercent}%` }"></span>
        </div>
        <p class="hint">占用上限 {{ sizePercent }}% · 上限 {{ MAX_UPLOAD_SIZE_LABEL }}</p>

        <div class="row">
          <button type="button" class="btn btn-sm" @click="openPicker">重新选择</button>
          <button type="button" class="btn btn-sm btn-danger" @click="clearFile">移除</button>
        </div>
      </div>

      <!-- 阈值设置 -->
      <div class="field">
        <label class="label" for="threshold">
          相似度阈值
          <span class="optional">默认 {{ DEFAULT_THRESHOLD }}，与后端一致</span>
        </label>
        <div class="row">
          <input
            id="threshold"
            v-model.number="threshold"
            class="range"
            type="range"
            min="0.3"
            max="0.95"
            step="0.01"
          />
          <span class="mono threshold-value">{{ threshold.toFixed(2) }}</span>
        </div>
        <p class="hint">
          调高 → 判定更严格，误认更少但可能漏认；调低 → 更容易认出人。
          <button type="button" class="link-btn" @click="resetThreshold">恢复默认</button>
        </p>
      </div>

      <button
        type="button"
        class="btn btn-primary btn-block recognize-btn"
        :disabled="!canRecognize"
        @click="runRecognize"
      >
        <span v-if="loading" class="spinner" aria-hidden="true"></span>
        <span v-else aria-hidden="true">🔍</span>
        {{ loading ? '识别中，首次推理需加载模型，请稍候…' : '开始识别' }}
      </button>

      <div v-if="errorMsg" class="alert alert-err" role="alert">
        <span aria-hidden="true">⚠️</span>
        <span>{{ errorMsg }}</span>
      </div>
    </section>

    <!-- ==================== 右：预览与结果 ==================== -->
    <section class="card">
      <div class="card-head">
        <div class="card-title"><span aria-hidden="true">📋</span> 识别结果</div>
        <span v-if="elapsedMs > 0" class="badge badge-neutral">耗时 {{ elapsedMs }} ms</span>
      </div>

      <!-- 图片预览 + 人脸框叠加层 -->
      <div v-if="previewUrl" class="preview">
        <div class="preview-stage">
          <img :src="previewUrl" alt="待识别图片预览" @load="onImageLoad" />

          <template v-if="result">
            <template v-for="(item, index) in result.results" :key="index">
              <div
                v-if="item.bbox"
                class="face-box"
                :class="[item.matched ? 'hit' : 'miss', { 'label-inside': labelInside(item.bbox) }]"
                :style="boxStyle(item.bbox)"
              >
                <span class="face-box-label">
                  {{ item.matched ? item.name : 'Unknown' }}
                  <em v-if="item.similarity !== null">{{ item.similarity.toFixed(2) }}</em>
                </span>
              </div>
            </template>
          </template>
        </div>
      </div>

      <!-- 结果区：加载 / 错误 / 空态 / 表格 -->
      <div v-if="loading" class="loading">
        <span class="spinner" aria-hidden="true"></span>
        正在检测并比对特征库……
      </div>

      <div v-else-if="!result" class="empty">
        <span class="empty-mark" aria-hidden="true">🫥</span>
        {{ file ? '图片已就绪，点击左侧「开始识别」' : '先选择一张图片，识别结果会显示在这里' }}
      </div>

      <template v-else>
        <ResultTable :results="result.results" :threshold="threshold" />
        <p v-if="result.facesDetected === 0" class="hint">
          后端未在图中检测到人脸（Haar 级联对侧脸、遮挡、过小人脸较敏感），建议换一张正脸清晰的图片。
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* ---------- 隐藏原生 input：视觉上隐藏但仍可被点击/无障碍读取 ---------- */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ---------- 拖拽放置区 ---------- */
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 34px 18px;
  border: 2px dashed var(--line-strong);
  border-radius: var(--radius);
  background: #fbfcfe;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, transform 0.08s;
}

.dropzone:hover,
.dropzone:focus-visible {
  border-color: var(--brand);
  background: var(--brand-soft);
  outline: none;
}

/* 拖拽悬停时给更强的视觉反馈 */
.dropzone.over {
  border-color: var(--brand);
  background: #e8edff;
  transform: scale(1.01);
}

.dropzone-icon {
  font-size: 26px;
  line-height: 1;
}

.dropzone-title {
  font-weight: 600;
  color: var(--ink);
}

.dropzone-hint {
  color: var(--muted);
  font-size: 12px;
}

/* ---------- 已选文件信息 ---------- */
.picked {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fbfcfe;
}

.picked-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.picked-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 13px;
}

/* ---------- 5MB 使用量进度条 ---------- */
.bar {
  height: 6px;
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

/* ---------- 阈值 ---------- */
.threshold-value {
  min-width: 44px;
  text-align: right;
  font-weight: 600;
  color: var(--brand);
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  text-decoration: underline;
}

.recognize-btn {
  margin-top: 16px;
  height: 42px;
}

/* ---------- 预览与人脸框 ---------- */
.preview {
  margin-bottom: 12px;
}

.preview-stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  border-radius: 12px;
  overflow: hidden;
  background: #0b1220;
  line-height: 0;
}

.preview-stage img {
  width: 100%;
  height: auto;
}

.face-box {
  position: absolute;
  border: 2px solid;
  border-radius: 3px;
  /* 白描边保证深色/浅色背景上都看得清 */
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

/* 人脸贴顶时，标注改到框内，避免被图片边缘裁掉 */
.face-box.label-inside .face-box-label {
  top: 2px;
  left: 2px;
}
</style>
