<script setup>
/**
 * UploadRecognize.vue —— 模块一：图片上传识别
 * ---------------------------------------------------------------------------
 * 对应后端接口：POST /api/recognize/upload（router/api.py）
 *   multipart 提交：file（图片）+ threshold（Form 字段，相似度阈值，默认 0.6）
 *   返回：{ faces_detected, results: [{ bbox:{x,y,w,h}, name, similarity }] }
 *
 * 交互链路：
 *   选择/拖拽图片 → 前端 5MB + 格式校验 → 本地预览（URL.createObjectURL）
 *   → 点击「开始识别」→ 再次校验 → 调接口 → 预览图上按原始像素坐标叠加人脸框
 *   → 表格列出每张人脸的判定结果
 *
 * 关于「5MB」的落点（核心约束，后端未限制请求体大小）：
 *   - 选中文件的瞬间就校验，超限直接拦下并给出实际体积，不用等上传失败；
 *   - 真正提交前再校验一次（file 是响应式引用，双保险成本极低）；
 *   - 上限常量来自 api/client.js 的 MAX_UPLOAD_SIZE，组件内不写魔数。
 *
 * 本次视觉优化：
 *   - 已选文件从"一行文字 + 进度条"升级为缩略图卡片，能直接认出选的是哪张图；
 *   - 阈值改为"标签 + 数值徽标 + 滑块"的单行结构，去掉冗长的说明句；
 *   - 空态统一为圆形图标底 + 标题 + 一句提示；
 *   - 图标全部换成 AppIcon，去掉参差的 emoji。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import AppIcon from '../components/AppIcon.vue'
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

/** 当前选中的图片文件 */
const file = ref(null)
/** 预览图 URL：createObjectURL 生成，用完必须 revoke */
const previewUrl = ref('')
/** 预览图的原始像素尺寸，人脸框按它换算百分比定位 */
const naturalSize = ref({ w: 0, h: 0 })
/** 错误提示 */
const errorMsg = ref('')
/** 相似度阈值，默认与后端一致 0.6 */
const threshold = ref(DEFAULT_THRESHOLD)
/** 请求进行中 */
const loading = ref(false)
/** 识别结果 { facesDetected, results } */
const result = ref(null)
/** 本次识别耗时（毫秒） */
const elapsedMs = ref(0)
/** 拖拽悬停高亮 */
const dragOver = ref(false)

/** 隐藏的原生 file input */
const fileInputRef = ref(null)

/* ===================== 派生状态 ===================== */

/** 文件大小文案 */
const sizeText = computed(() => (file.value ? formatFileSize(file.value.size) : ''))

/** 图片原始分辨率文案，加载完成前为空 */
const dimensionText = computed(() =>
  naturalSize.value.w ? `${naturalSize.value.w} × ${naturalSize.value.h}` : ''
)

/** 体积占 5MB 的百分比，用于可视化上限 */
const sizePercent = computed(() => {
  if (!file.value) return 0
  return Math.min(100, Math.round((file.value.size / MAX_UPLOAD_SIZE) * 100))
})

/** 进度条配色：≥80% 提醒，满格转红 */
const sizeBarClass = computed(() => {
  if (sizePercent.value >= 100) return 'bar-danger'
  if (sizePercent.value >= 80) return 'bar-warn'
  return 'bar-ok'
})

/** 是否可以点「开始识别」 */
const canRecognize = computed(() => Boolean(file.value) && !loading.value)

/* ===================== 文件选择与校验 ===================== */

function openPicker() {
  fileInputRef.value?.click()
}

/**
 * 原生 input 的 change 事件。
 * 选完必须把 input.value 置空，否则连续选同一个文件不会触发 change，
 * 用户会以为按钮失灵（<input type=file> 的经典坑）。
 */
function onFileChange(event) {
  const picked = event.target.files?.[0]
  event.target.value = ''
  if (picked) applyFile(picked)
}

function onDragOver() {
  dragOver.value = true
}

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
 * 接收文件：先校验（含 5MB 上限），通过后生成本地预览。
 * @param {File} picked
 */
function applyFile(picked) {
  // 1. 校验：类型 / 体积 / 空文件，任一不通过都不进入预览
  const err = validateImageFile(picked)
  if (err) {
    errorMsg.value = err
    return
  }

  // 2. 清理上一轮状态，避免旧结果和新图片错位
  errorMsg.value = ''
  result.value = null
  elapsedMs.value = 0
  naturalSize.value = { w: 0, h: 0 }
  revokePreview()

  // 3. 绑定新文件并生成预览（createObjectURL 不读盘内容，大图也秒开）
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
 * 后端 bbox 是「原图坐标系」下的像素值，而预览图被 CSS 缩放，
 * 必须拿到 naturalWidth / naturalHeight 才能换算成正确的百分比位置。
 */
function onImageLoad(event) {
  naturalSize.value = {
    w: event.target.naturalWidth || 0,
    h: event.target.naturalHeight || 0,
  }
}

/* ===================== 调用识别接口 ===================== */

/**
 * 执行识别。失败时只显示 message，不弹 alert —— 用户可直接改阈值重试。
 */
async function runRecognize() {
  if (!file.value || loading.value) return

  // 提交前二次校验 5MB
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
    result.value = await recognizeUpload(file.value, threshold.value)
    elapsedMs.value = Math.round(performance.now() - startedAt)
  } catch (e) {
    errorMsg.value = e.message || '识别失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

/** 阈值恢复后端默认值 */
function resetThreshold() {
  threshold.value = DEFAULT_THRESHOLD
}

/* ===================== 人脸框叠加 ===================== */

/**
 * 像素坐标 → 相对预览图的百分比定位。
 * 用百分比而不是绝对像素：预览图被容器自适应缩放后，人脸框依然严丝合缝，
 * 拖动窗口大小也不会错位。
 * @param {{x:number,y:number,w:number,h:number}|null} bbox
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

/** 人脸贴顶时把标注文字放进框内，否则会被图片上边缘裁掉 */
function labelInside(bbox) {
  return Boolean(bbox) && bbox.y < 26
}

onBeforeUnmount(revokePreview)
</script>

<template>
  <div class="split fade-in">
    <!-- ==================== 左：上传与参数 ==================== -->
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title">
            <AppIcon name="upload" :size="18" />
            上传图片
          </div>
          <p class="card-desc">
            支持 jpg / png / bmp / webp，单张不超过 <strong>{{ MAX_UPLOAD_SIZE_LABEL }}</strong>
            （{{ MAX_UPLOAD_SIZE.toLocaleString() }} 字节）
          </p>
        </div>
      </div>

      <input
        ref="fileInputRef"
        type="file"
        class="sr-only"
        :accept="ACCEPT_ATTR"
        @change="onFileChange"
      />

      <!-- 未选图：拖拽放置区 -->
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
        <span class="dropzone-icon">
          <AppIcon name="upload" :size="20" />
        </span>
        <p class="dropzone-title">点击选择图片</p>
        <p class="dropzone-sub">或把图片拖到这里</p>
        <span class="badge badge-neutral">≤ {{ MAX_UPLOAD_SIZE_LABEL }}</span>
      </div>

      <!-- 已选图：缩略图卡片 -->
      <div v-else class="file-card">
        <img :src="previewUrl" alt="" class="thumb" @load="onImageLoad" />

        <div class="file-info">
          <p class="file-name" :title="file.name">{{ file.name }}</p>
          <div class="file-meta">
            <span>{{ sizeText }}</span>
            <template v-if="dimensionText">
              <i class="sep" aria-hidden="true"></i>
              <span>{{ dimensionText }}</span>
            </template>
          </div>
          <!-- 5MB 使用量：把限制可视化，而不是只在报错时才出现 -->
          <div class="bar file-bar" role="progressbar" :aria-valuenow="sizePercent" aria-valuemin="0" aria-valuemax="100">
            <span class="bar-fill" :class="sizeBarClass" :style="{ width: `${sizePercent}%` }"></span>
          </div>
          <p class="file-usage">已用 5MB 上限的 {{ sizePercent }}%</p>
        </div>

        <button type="button" class="icon-btn icon-btn-danger" title="移除图片" aria-label="移除图片" @click="clearFile">
          <AppIcon name="x" :size="16" />
        </button>
      </div>

      <hr class="card-divider" />

      <!-- 阈值 -->
      <div class="field">
        <div class="row-between field-head">
          <label class="label" for="threshold">
            相似度阈值
            <span class="optional">默认 {{ DEFAULT_THRESHOLD }}</span>
          </label>
          <span class="value-chip">{{ threshold.toFixed(2) }}</span>
        </div>
        <input
          id="threshold"
          v-model.number="threshold"
          class="range"
          type="range"
          min="0.3"
          max="0.95"
          step="0.01"
        />
        <p class="hint">
          调高更严格、误认更少；调低更容易认出人。
          <button type="button" class="link-btn" @click="resetThreshold">恢复默认</button>
        </p>
      </div>

      <button
        type="button"
        class="btn btn-primary btn-block cta"
        :disabled="!canRecognize"
        @click="runRecognize"
      >
        <span v-if="loading" class="spinner" aria-hidden="true"></span>
        <AppIcon v-else name="scan-face" :size="17" />
        {{ loading ? '识别中，请稍候…' : '开始识别' }}
      </button>

      <div v-if="errorMsg" class="alert alert-err cta-alert" role="alert">
        <AppIcon name="alert" :size="15" />
        <span>{{ errorMsg }}</span>
      </div>
    </section>

    <!-- ==================== 右：预览与结果 ==================== -->
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

      <!-- card-fill：占满头部以下的空间，让空态/加载态在其中垂直居中 -->
      <div class="card-fill">
        <!-- 预览 + 人脸框叠加 -->
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

        <div v-if="loading" class="loading">
          <span class="spinner" aria-hidden="true"></span>
          正在检测并比对特征库……
        </div>

        <div v-else-if="!result" class="empty">
          <span class="empty-mark"><AppIcon name="empty-target" :size="22" /></span>
          <p class="empty-title">{{ file ? '图片已就绪' : '还没有选择图片' }}</p>
          <p class="hint">{{ file ? '点击左侧「开始识别」查看结果' : '识别结果会显示在这里' }}</p>
        </div>

        <ResultTable v-else :results="result.results" :threshold="threshold" />
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ---------- 放置区 ---------- */
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 30px 18px;
  border: 1.5px dashed var(--line-strong);
  border-radius: var(--r-md);
  background: #fcfcfd;
  text-align: center;
  cursor: pointer;
  transition: border-color var(--t), background var(--t), transform 0.1s;
}

.dropzone:hover,
.dropzone:focus-visible {
  border-color: var(--brand);
  background: var(--brand-soft);
  outline: none;
}

.dropzone.over {
  border-color: var(--brand);
  background: #e9edff;
  transform: scale(1.005);
}

/* 图标放在浅色圆底里，比裸图标更稳，也不会让虚线框显得空 */
.dropzone-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-bottom: 2px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid var(--line);
  color: var(--brand);
  box-shadow: var(--shadow-sm);
}

.dropzone-title {
  font-weight: 600;
  color: var(--ink);
}

.dropzone-sub {
  color: var(--muted);
  font-size: 13px;
}

/* ---------- 已选文件卡片 ---------- */
.file-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: #fcfcfd;
}

/* 方形缩略图：object-fit: cover 保证不同比例都不变形 */
.thumb {
  width: 64px;
  height: 64px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  object-fit: cover;
  background: #eef1f6;
  flex: none;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
}

.file-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
  color: var(--muted);
  font-size: 12.5px;
}

/* 元信息之间的小圆点分隔，比竖线更轻 */
.sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--line-strong);
}

.file-bar {
  margin-top: 8px;
}

.file-usage {
  margin-top: 4px;
  color: var(--faint);
  font-size: 12px;
}

/* ---------- 阈值与按钮 ---------- */
.field-head {
  margin-bottom: 7px;
}

.field-head .label {
  margin-bottom: 0;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12.5px;
  text-decoration: none;
  border-bottom: 1px solid transparent;
}

.link-btn:hover {
  border-bottom-color: currentColor;
}

.cta {
  height: 42px;
  margin-top: 18px;
}

.cta-alert {
  margin-top: 12px;
}

/* ---------- 预览与人脸框 ---------- */
.preview {
  margin-bottom: 14px;
}

.preview-stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  border-radius: var(--r-md);
  overflow: hidden;
  background: #0b1220;
  /* 去掉行内元素默认的基线留白，否则图片下方会有几像素空隙 */
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
  /* 白描边保证深浅背景上都看得清 */
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

/* 人脸贴顶时把标注放进框内 */
.face-box.label-inside .face-box-label {
  top: 2px;
  left: 2px;
}
</style>
