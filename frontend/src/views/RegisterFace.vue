<script setup>
/**
 * RegisterFace.vue —— 模块三：人脸录入
 * ---------------------------------------------------------------------------
 * 对应后端接口：POST /api/register
 *   multipart 提交：file（人脸图片）+ name（Form 字段，姓名/身份标签）
 *   返回：{ record_id, name }
 *
 * 后端行为（决定前端提示怎么写）：
 *   1. 一张图只录入「面积最大的那张脸」，避免多脸歧义 —— 引导用户用单人正脸照；
 *   2. 检测不到人脸 → HTTP 422「未检测到人脸，请更换图片」；
 *   3. 同名记录已存在 → HTTP 409「已存在特征记录，请先删除再重录」，
 *      即姓名在特征库里是唯一键；
 *   4. 姓名会 trim 后入库，前端也先 trim，避免只输入空格被后端拦下。
 *
 * 5MB 上限：与识别模块同一套校验（validateImageFile），后端未限制请求体大小。
 *
 * 本次视觉优化：
 *   - 表单字段用统一的 label / input / 文件卡片结构，与识别模块保持一致的心智模型；
 *   - 右侧"须知"由长段落改为带序号的清单，扫读成本更低；
 *   - 录入成功后的记录信息用 .kv 键值行呈现，不再是一块绿色卡片。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import AppIcon from '../components/AppIcon.vue'
import { ACCEPT_ATTR, MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_LABEL, formatFileSize, validateImageFile } from '../api/client'
import { registerFace } from '../api/face'

/**
 * 向父组件（App.vue）广播：
 *   - emit('registered', { recordId, name })  录入成功，仅通知
 *   - emit('registered', null)               用户点了「去特征库查看」
 */
const emit = defineEmits(['registered'])

/* ===================== 状态 ===================== */

/** 姓名（v-model.trim 已去掉首尾空格） */
const name = ref('')
/** 选中的图片 */
const file = ref(null)
/** 预览 URL */
const previewUrl = ref('')
/** 错误提示 */
const errorMsg = ref('')
/** 成功提示 */
const successMsg = ref('')
/** 最近一次录入成功的记录 */
const lastRegistered = ref(null)
/** 提交中 */
const submitting = ref(false)
/** 拖拽悬停 */
const dragOver = ref(false)

const fileInputRef = ref(null)

/* ===================== 派生状态 ===================== */

/** 姓名是否合法 */
const nameValid = computed(() => name.value.trim().length > 0)

/** 是否可提交 */
const canSubmit = computed(() => nameValid.value && Boolean(file.value) && !submitting.value)

/** 文件大小文案 */
const sizeText = computed(() => (file.value ? formatFileSize(file.value.size) : ''))

/* ===================== 文件选择 ===================== */

function openPicker() {
  fileInputRef.value?.click()
}

/** change 后立即清空 input.value，保证再次选择同一文件也能触发 */
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

function onDrop(event) {
  event.preventDefault()
  dragOver.value = false
  const picked = event.dataTransfer?.files?.[0]
  if (picked) applyFile(picked)
}

/**
 * 接收文件：先做 5MB + 格式校验，再生成预览。
 * @param {File} picked
 */
function applyFile(picked) {
  const err = validateImageFile(picked)
  if (err) {
    errorMsg.value = err
    return
  }
  errorMsg.value = ''
  successMsg.value = ''
  revokePreview()
  file.value = picked
  previewUrl.value = URL.createObjectURL(picked)
}

/** 释放预览 URL */
function revokePreview() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
}

function clearFile() {
  revokePreview()
  file.value = null
}

/* ===================== 提交录入 ===================== */

/**
 * 提交录入。成功 / 失败都只更新页面提示；
 * 失败时保留已选图片和姓名，用户改一下就能重试。
 */
async function submit() {
  if (submitting.value) return

  const trimmedName = name.value.trim()
  if (!trimmedName) {
    errorMsg.value = '请填写姓名（身份标签）'
    return
  }

  if (!file.value) {
    errorMsg.value = '请选择一张人脸图片'
    return
  }

  const sizeErr = validateImageFile(file.value)
  if (sizeErr) {
    errorMsg.value = sizeErr
    return
  }

  submitting.value = true
  errorMsg.value = ''
  successMsg.value = ''
  lastRegistered.value = null

  try {
    const res = await registerFace(file.value, trimmedName)
    lastRegistered.value = res
    successMsg.value = `「${res.name}」录入成功`
    // 清空表单方便连续录入下一个人；成功提示与记录卡保留
    name.value = ''
    clearFile()
    emit('registered', res)
  } catch (e) {
    errorMsg.value = e.message || '录入失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

/** 跳转特征库（由父组件切换导航） */
function goFeatures() {
  emit('registered', null)
}

onBeforeUnmount(revokePreview)
</script>

<template>
  <div class="split fade-in">
    <!-- ==================== 左：录入表单 ==================== -->
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title">
            <AppIcon name="user-plus" :size="17" />
            录入人脸
          </div>
          <p class="card-desc">
            上传一张正脸图片并绑定姓名，后端会提取 512 维特征写入 SQLite 特征库
          </p>
        </div>
      </div>

      <!-- 姓名 -->
      <div class="field">
        <label class="label" for="person-name">
          姓名 / 身份标签
          <span class="optional">入库后作为识别结果展示</span>
        </label>
        <input
          id="person-name"
          v-model.trim="name"
          class="input"
          type="text"
          maxlength="32"
          placeholder="例如：张三"
          :disabled="submitting"
          @keydown.enter.prevent="canSubmit && submit()"
        />
        <p class="hint">姓名在特征库中唯一，重复录入会提示已存在，需先删除旧记录。</p>
      </div>

      <!-- 图片 -->
      <div class="field">
        <label class="label">
          人脸图片
          <span class="optional">≤ {{ MAX_UPLOAD_SIZE_LABEL }}（{{ MAX_UPLOAD_SIZE.toLocaleString() }} 字节）</span>
        </label>

        <input
          ref="fileInputRef"
          type="file"
          class="sr-only"
          :accept="ACCEPT_ATTR"
          @change="onFileChange"
        />

        <div
          v-if="!file"
          class="dropzone"
          :class="{ over: dragOver }"
          role="button"
          tabindex="0"
          aria-label="选择或拖拽人脸图片"
          @click="openPicker"
          @keydown.enter.prevent="openPicker"
          @keydown.space.prevent="openPicker"
          @dragover.prevent="onDragOver"
          @dragleave.prevent="onDragLeave"
          @drop="onDrop"
        >
          <span class="dropzone-icon"><AppIcon name="user-plus" :size="20" /></span>
          <p class="dropzone-title">点击选择人脸图片</p>
          <p class="dropzone-sub">或把图片拖到这里 · 建议正脸、光线充足、单人</p>
        </div>

        <div v-else class="file-card">
          <img :src="previewUrl" alt="待录入人脸预览" class="thumb" />
          <div class="file-info">
            <p class="file-name" :title="file.name">{{ file.name }}</p>
            <p class="file-meta">{{ sizeText }}</p>
          </div>
          <button type="button" class="icon-btn" title="重新选择" aria-label="重新选择" @click="openPicker">
            <AppIcon name="refresh" :size="15" />
          </button>
          <button type="button" class="icon-btn icon-btn-danger" title="移除" aria-label="移除" @click="clearFile">
            <AppIcon name="x" :size="15" />
          </button>
        </div>
      </div>

      <button type="button" class="btn btn-primary btn-block cta" :disabled="!canSubmit" @click="submit">
        <span v-if="submitting" class="spinner" aria-hidden="true"></span>
        <AppIcon v-else name="check" :size="16" :stroke-width="2.1" />
        {{ submitting ? '录入中，正在提取特征…' : '提交录入' }}
      </button>

      <div v-if="errorMsg" class="alert alert-err alert-gap" role="alert">
        <AppIcon name="alert" :size="15" />
        <span>{{ errorMsg }}</span>
      </div>

      <div v-if="successMsg" class="alert alert-ok alert-gap" role="status">
        <AppIcon name="check" :size="15" :stroke-width="2.2" />
        <div>
          <p>{{ successMsg }}</p>
          <button type="button" class="link-btn go-link" @click="goFeatures">
            去特征库查看
            <AppIcon name="arrow-right" :size="13" />
          </button>
        </div>
      </div>
    </section>

    <!-- ==================== 右：须知与结果 ==================== -->
    <section class="card">
      <div class="card-head">
        <div class="card-title">
          <AppIcon name="info" :size="17" />
          录入须知
        </div>
      </div>

      <ol class="tips">
        <li class="tip">
          <span class="tip-num" aria-hidden="true">1</span>
          <div>
            <p class="tip-title">一人一档</p>
            <p class="tip-text">按姓名判重，同名再次提交会返回 409。更新特征请先在「特征库」删除该姓名。</p>
          </div>
        </li>
        <li class="tip">
          <span class="tip-num" aria-hidden="true">2</span>
          <div>
            <p class="tip-title">只取最大人脸</p>
            <p class="tip-text">图片中有多张脸时，后端只录入面积最大的那一张，请尽量使用单人照。</p>
          </div>
        </li>
        <li class="tip">
          <span class="tip-num" aria-hidden="true">3</span>
          <div>
            <p class="tip-title">图片质量</p>
            <p class="tip-text">Haar 级联对侧脸、遮挡、强逆光、人脸过小都较敏感，正脸清晰照成功率最高。</p>
          </div>
        </li>
        <li class="tip">
          <span class="tip-num" aria-hidden="true">4</span>
          <div>
            <p class="tip-title">体积限制</p>
            <p class="tip-text">单张不得超过 {{ MAX_UPLOAD_SIZE_LABEL }}，超限会在选择文件的瞬间被前端拦下。</p>
          </div>
        </li>
      </ol>

      <!-- 成功后展示本次写入的记录 -->
      <template v-if="lastRegistered">
        <hr class="card-divider" />
        <div class="record">
          <div class="kv">
            <span class="kv-key">姓名</span>
            <span class="kv-val">{{ lastRegistered.name }}</span>
          </div>
          <div class="kv">
            <span class="kv-key">记录 ID</span>
            <span class="kv-val mono">{{ lastRegistered.recordId ?? '—' }}</span>
          </div>
          <div class="kv">
            <span class="kv-key">特征维度</span>
            <span class="kv-val mono">512</span>
          </div>
        </div>
      </template>
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
  padding: 28px 18px;
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

.dropzone-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-bottom: 2px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: #fff;
  color: var(--brand);
  box-shadow: var(--shadow-sm);
}

.dropzone-title {
  font-weight: 600;
  color: var(--ink);
}

.dropzone-sub {
  color: var(--muted);
  font-size: 12.5px;
}

/* ---------- 已选文件 ---------- */
.file-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: #fcfcfd;
}

.thumb {
  width: 52px;
  height: 52px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
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
  font-size: 13px;
  font-weight: 550;
}

.file-meta {
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}

/* ---------- 按钮与提示 ---------- */
.cta {
  height: 42px;
  margin-top: 18px;
}

.alert-gap {
  margin-top: 12px;
}

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12.5px;
}

.link-btn:hover {
  text-decoration: underline;
}

.go-link {
  margin-top: 3px;
}

/* ---------- 须知清单 ---------- */
.tips {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tip {
  display: flex;
  gap: 10px;
}

/* 序号放在圆形色块里，形成清楚的阅读节奏 */
.tip-num {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-dark);
  font-size: 11.5px;
  font-weight: 700;
  flex: none;
}

.tip-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.tip-text {
  margin-top: 1px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}

/* ---------- 成功后的记录 ---------- */
.record {
  padding: 4px 12px;
  border: 1px solid var(--ok-line);
  border-radius: var(--r-md);
  background: var(--ok-soft);
}
</style>
