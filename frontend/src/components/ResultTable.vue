<script setup>
/**
 * ResultTable.vue —— 识别结果表（图片识别 / 摄像头识别共用）
 * ---------------------------------------------------------------------------
 * 后端两个识别接口返回的 results 经 src/api/face.js 的 normalizeRecognizePayload()
 * 归一化后结构一致：
 *   { bbox: {x,y,w,h}|null, name: string|null, similarity: number|null, matched: boolean }
 *
 * 组件职责单一：只渲染，不发请求、不发事件，保证两个识别模块的结果展示完全一致。
 *
 * 本次视觉优化：
 *   - 汇总信息从"一排胶囊"改成"数字 + 说明"的统计行，数字用等宽字重突出；
 *   - 相似度加了一条迷你条形图，既保留 4 位小数精度，又能一眼比出谁最像；
 *   - 未识别的行整体降饱和（姓名用灰、相似度显示 —），让命中行自然突出。
 */
import { computed } from 'vue'

import AppIcon from './AppIcon.vue'

const props = defineProps({
  /** 归一化后的识别结果数组 */
  results: { type: Array, default: () => [] },
  /** 当前相似度阈值，用于在汇总行说明判定标准 */
  threshold: { type: Number, default: 0.6 },
})

/** 命中数：matched 为 true 表示比中了特征库里某个已录入人员 */
const matchedCount = computed(() => props.results.filter((item) => item.matched).length)

/** 全部命中 / 全部未命中，用于决定汇总数字的颜色 */
const summaryTone = computed(() => {
  if (props.results.length === 0) return 'neutral'
  if (matchedCount.value === 0) return 'err'
  if (matchedCount.value === props.results.length) return 'ok'
  return 'warn'
})

/**
 * 相似度文本：后端保留 4 位小数，null 表示没参与比对（如特征提取失败）
 * @param {number|null} value
 */
function similarityText(value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toFixed(4)
}

/**
 * 相似度条形图宽度（百分比）。
 * 相似度理论上落在 0~1，但余弦相似度偶尔会出现负值或略超 1 的极端情况，做一次夹取。
 * @param {number|null} value
 */
function similarityPercent(value) {
  if (value === null || value === undefined) return 0
  return Math.max(0, Math.min(100, Number(value) * 100))
}

/**
 * 人脸框坐标文案："x, y · 宽×高"
 * @param {{x:number,y:number,w:number,h:number}|null} bbox
 */
function bboxText(bbox) {
  if (!bbox) return '—'
  return `${Math.round(bbox.x)}, ${Math.round(bbox.y)} · ${Math.round(bbox.w)}×${Math.round(bbox.h)}`
}
</script>

<template>
  <!-- 没有任何人脸：给明确的空态与排查方向 -->
  <div v-if="results.length === 0" class="empty">
    <span class="empty-mark"><AppIcon name="face-none" :size="22" /></span>
    <p class="empty-title">未检测到人脸</p>
    <p class="hint">Haar 级联对侧脸、遮挡、强逆光、过小人脸较敏感，换一张正脸清晰的图片试试</p>
  </div>

  <div v-else>
    <!-- 汇总行：数字突出，说明文字弱化 -->
    <div class="summary">
      <div class="summary-main">
        <span class="stat">
          <b class="stat-num">{{ results.length }}</b>
          <span class="stat-label">张人脸</span>
        </span>
        <span class="summary-divider" aria-hidden="true"></span>
        <span class="stat">
          <b class="stat-num" :class="`tone-${summaryTone}`">{{ matchedCount }}</b>
          <span class="stat-label">命中</span>
        </span>
      </div>
      <span class="summary-note">阈值 ≥ {{ threshold.toFixed(2) }} 判定为同一人</span>
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th>识别结果</th>
            <th style="width: 132px">相似度</th>
            <th style="width: 148px">人脸框 (x, y · w×h)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in results" :key="index">
            <td class="col-num">{{ index + 1 }}</td>

            <!-- 姓名列：命中给绿徽标，未命中给中性文案（不用红色，避免整页报警感） -->
            <td>
              <span v-if="item.matched" class="badge badge-ok">
                <AppIcon name="check" :size="12" :stroke-width="2.4" />
                {{ item.name }}
              </span>
              <span v-else class="unmatched">未识别</span>
            </td>

            <!-- 相似度列：条形图 + 精确数值 -->
            <td>
              <div v-if="item.similarity !== null" class="sim">
                <span class="sim-bar" aria-hidden="true">
                  <i
                    class="sim-fill"
                    :class="item.matched ? 'sim-hit' : 'sim-miss'"
                    :style="{ width: `${similarityPercent(item.similarity)}%` }"
                  ></i>
                </span>
                <span class="sim-value" :class="item.matched ? 'text-ok' : 'text-muted'">
                  {{ similarityText(item.similarity) }}
                </span>
              </div>
              <span v-else class="text-faint">—</span>
            </td>

            <td class="mono text-faint nowrap">{{ bboxText(item.bbox) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 汇总行 ---------- */
.summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--line);
}

.summary-main {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.stat {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}

/* 数字用 19px 等宽，让 1 和 10 的宽度差异不影响对齐 */
.stat-num {
  font-family: 'Cascadia Code', Consolas, Monaco, monospace;
  font-size: 21px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--ink);
}

.stat-num.tone-ok {
  color: var(--ok);
}
.stat-num.tone-err {
  color: var(--err);
}
.stat-num.tone-warn {
  color: var(--warn);
}

.stat-label {
  color: var(--muted);
  font-size: 13px;
}

.summary-divider {
  width: 1px;
  height: 14px;
  background: var(--line-strong);
  align-self: center;
}

.summary-note {
  color: var(--faint);
  font-size: 12.5px;
}

/* ---------- 未识别人脸 ---------- */
.unmatched {
  color: var(--faint);
  font-size: 13.5px;
}

/* ---------- 相似度条 ---------- */
.sim {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sim-bar {
  position: relative;
  flex: 1;
  height: 4px;
  min-width: 48px;
  border-radius: 999px;
  background: #eef0f4;
  overflow: hidden;
}

.sim-fill {
  position: absolute;
  inset: 0 auto 0 0;
  display: block;
  border-radius: 999px;
  transition: width 0.25s ease;
}

.sim-hit {
  background: #16a34a;
}

/* 未命中也要能看出"有多接近阈值"，用中性灰而不是红 */
.sim-miss {
  background: #c7ccd4;
}

.sim-value {
  min-width: 46px;
  font-family: 'Cascadia Code', Consolas, Monaco, monospace;
  font-size: 13px;
  text-align: right;
}

/* 表头下不需要额外的上边框（.summary 已有） */
.table th:first-child {
  border-top-left-radius: 0;
}
</style>
