<script setup>
/**
 * RegisterFace.vue —— 模块三：人脸录入
 * ---------------------------------------------------------------------------
 * 对应后端接口：POST /api/register
 *   multipart 提交：file（人脸图片）+ name（Form 字段，姓名/身份标签）
 *   返回：{ record_id, name }
 *
 * 后端行为（决定了前端要做哪些提示）：
 *   1. 一张图里只录入「面积最大的那张脸」，避免多脸歧义 —— 所以界面要引导用户
 *      使用只有一张正脸的图片；
 *   2. 检测不到人脸 → HTTP 422「未检测到人脸，请更换图片」；
 *   3. 同名记录已存在 → HTTP 409「已存在特征记录，请先删除再重录」，
 *      即姓名在特征库里是唯一键，重复上传同名图片不会产生第二条记录；
 *   4. 姓名会 trim 后入库，前端也先 trim，避免只输入空格被后端拦下。
 *
 * 5MB 上限：与识别模块同一套校验（validateImageFile），
 * 后端 router/api.py 未限制请求体大小，必须前端把关。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import { ACCEPT_ATTR, MAX_UPLOAD_SIZE_LABEL, formatFileSize, validateImageFile } from '../api/client'
import { registerFace } from '../api/face'

/**
 * 向父组件（App.vue）广播「录入成功」事件。
 * App.vue 收到后可以把导航切到「特征库」，让用户立刻看到刚录入的人。
 */
const emit = defineEmits(['registered'])

/* ===================== 状态 ===================== */

/** 姓名输入（v-model.trim 已去掉首尾空格） */
const name = ref('')
/** 选中的图片文件 */
const file = ref(null)
/** 预览 URL，用完需 revoke */
const previewUrl = ref('')
/** 错误提示 */
const errorMsg = ref('')
/** 成功提示 */
const successMsg = ref('')
/** 最近一次录入成功的记录信息 { recordId, name } */
const lastRegistered = ref(null)
/** 提交中 */
const submitting = ref(false)
/** 拖拽悬停高亮 */
const dragOver = ref(false)

/** 隐藏的原生 file input */
const fileInputRef = ref(null)

/* ===================== 派生状态 ===================== */

/** 姓名是否合法：去掉空格后非空 */
const nameValid = computed(() => name.value.trim().length > 0)

/** 表单是否可提交 */
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

/** 移除已选图片 */
function clearFile() {
  revokePreview()
  file.value = null
}

/* ===================== 提交录入 ===================== */

/**
 * 提交录入请求。
 * 成功 / 失败都只更新页面提示，不打断用户；失败时保留已选图片和姓名，
 * 用户改一下就能重试（例如提示"已存在"时去特征库删掉再回来）。
 */
async function submit() {
  if (submitting.value) return

  // 1. 姓名校验
  const trimmedName = name.value.trim()
  if (!trimmedName) {
    errorMsg.value = '请填写姓名（身份标签）'
    return
  }

  // 2. 图片存在性 + 体积二次校验
  if (!file.value) {
    errorMsg.value = '请选择一张人脸图片'
    return
  }
  const sizeErr = validateImageFile(file.value)
  if (sizeErr) {
    errorMsg.value = sizeErr
    return
  }

  // 3. 发请求
  submitting.value = true
  errorMsg.value = ''
  successMsg.value = ''
  lastRegistered.value = null

  try {
    const res = await registerFace(file.value, trimmedName)
    lastRegistered.value = res
    successMsg.value = `「${res.name}」录入成功${res.recordId ? `，记录 ID：${res.recordId}` : ''}`
    // 清空表单，方便连续录入下一个人；成功提示保留在页面上
    name.value = ''
    clearFile()
    // 通知父组件（可用于自动跳到特征库）
    emit('registered', res)
  } catch (e) {
    // 422 未检测到人脸 / 409 同名已存在 / 其它网络错误，client.js 已转成中文
    errorMsg.value = e.message || '录入失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

/** 跳转到特征库（由父组件切换导航） */
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
          <div class="card-title"><span aria-hidden="true">👤</span> 录入人脸</div>
          <p class="card-desc">
            上传一张正脸图片并绑定姓名，后端会提取 512 维特征写入 SQLite 特征库
          </p>
        </div>
      </div>

      <!-- 姓名 -->
      <div class="field">
        <label class="label" for="person-name">
          姓名 / 身份标签
          <span class="optional">入库后会作为识别结果展示</span>
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
        <p class="hint">
          特征库中姓名唯一：同一个人重复录入会提示「已存在」，需先在特征库删除旧记录。
        </p>
      </div>

      <!-- 图片 -->
      <div class="field">
        <label class="label">
          人脸图片
          <span class="optional">jpg / png / bmp / webp，≤ {{ MAX_UPLOAD_SIZE_LABEL }}</span>
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
          <div class="dropzone-icon" aria-hidden="true">🙂</div>
          <p class="dropzone-title">点击选择人脸图片，或拖到这里</p>
          <p class="dropzone-hint">建议正脸、光线充足、画面中只有一张脸</p>
        </div>

        <div v-else class="picked">
          <div class="picked-main">
            <img :src="previewUrl" alt="待录入人脸预览" class="thumb" />
            <div class="picked-info">
              <span class="picked-name" :title="file.name">{{ file.name }}</span>
              <span class="badge badge-neutral">{{ sizeText }}</span>
              <button type="button" class="link-btn" @click="openPicker">重新选择</button>
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-danger" @click="clearFile">移除</button>
        </div>
      </div>

      <button type="button" class="btn btn-primary btn-block submit-btn" :disabled="!canSubmit" @click="submit">
        <span v-if="submitting" class="spinner" aria-hidden="true"></span>
        <span v-else aria-hidden="true">💾</span>
        {{ submitting ? '录入中，正在提取特征…' : '提交录入' }}
      </button>

      <div v-if="errorMsg" class="alert alert-err" role="alert">
        <span aria-hidden="true">⚠️</span>
        <span>{{ errorMsg }}</span>
      </div>

      <div v-if="successMsg" class="alert alert-ok" role="status">
        <span aria-hidden="true">✅</span>
        <div>
          <p>{{ successMsg }}</p>
          <button type="button" class="link-btn go-link" @click="goFeatures">
            去特征库查看 →
          </button>
        </div>
      </div>
    </section>

    <!-- ==================== 右：录入须知 ==================== -->
    <section class="card">
      <div class="card-head">
        <div class="card-title"><span aria-hidden="true">📌</span> 录入须知</div>
      </div>

      <ol class="tips">
        <li>
          <strong>一人一档：</strong>后端按姓名判重，同名再次提交会返回 409。
          要更新某人特征，请先到「特征库」删除该姓名下的记录。
        </li>
        <li>
          <strong>只取最大人脸：</strong>图片中有多张脸时，后端只录入面积最大的那一张，
          所以请尽量上传单人照，避免录错人。
        </li>
        <li>
          <strong>图片质量：</strong>Haar 级联检测对侧脸、遮挡、强逆光、人脸过小都较敏感，
          正脸清晰照的识别成功率明显更高。
        </li>
        <li>
          <strong>体积限制：</strong>单张图片不得超过 {{ MAX_UPLOAD_SIZE_LABEL }}，
          超限时前端会在选择文件的瞬间拦下，不会发起请求。
        </li>
        <li>
          <strong>录入 ≠ 立即生效的同步感知：</strong>特征写入 SQLite 后，
          下一次识别请求就会带上它（后端每次识别都从库里读全量特征）。
        </li>
      </ol>

      <!-- 成功后的记录信息卡片 -->
      <div v-if="lastRegistered" class="record-card">
        <div class="record-row">
          <span class="text-muted">姓名</span>
          <strong>{{ lastRegistered.name }}</strong>
        </div>
        <div class="record-row">
          <span class="text-muted">记录 ID</span>
          <span class="mono">{{ lastRegistered.recordId ?? '—' }}</span>
        </div>
        <div class="record-row">
          <span class="text-muted">特征维度</span>
          <span class="mono">512</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 隐藏原生 input */
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

/* ---------- 放置区 ---------- */
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 30px 18px;
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
}

.dropzone-hint {
  color: var(--muted);
  font-size: 12px;
}

/* ---------- 已选文件 ---------- */
.picked {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fbfcfe;
}

.picked-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* 方形缩略图：object-fit: cover 保证不同比例都不变形 */
.thumb {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  object-fit: cover;
  background: #eef1f6;
  flex: none;
}

.picked-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.picked-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  text-decoration: underline;
}

.submit-btn {
  margin-top: 16px;
  height: 42px;
}

.go-link {
  margin-top: 4px;
  font-size: 12.5px;
}

/* ---------- 须知 ---------- */
.tips {
  margin: 0;
  padding-left: 20px;
  color: var(--ink-soft);
  font-size: 13px;
}

.tips li + li {
  margin-top: 9px;
}

.tips strong {
  color: var(--ink);
}

/* ---------- 成功后的记录卡 ---------- */
.record-card {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid #bbf7d0;
  border-radius: var(--radius-sm);
  background: var(--ok-soft);
  font-size: 13px;
}

.record-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.record-row + .record-row {
  margin-top: 4px;
}
</style>
