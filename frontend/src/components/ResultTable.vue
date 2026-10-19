<script setup>
/**
 * ResultTable.vue —— 识别结果表（图片识别 / 摄像头识别两个模块共用）
 * ---------------------------------------------------------------------------
 * 后端 /api/recognize/upload 与 /api/recognize/frame 返回的 results 结构在经过
 * src/api/face.js 的 normalizeRecognizePayload() 之后已经完全一致，因此这里只需要
 * 关心一种数据结构：
 *   { bbox: {x,y,w,h}|null, name: string|null, similarity: number|null, matched: boolean }
 *
 * 组件职责单一：把结果渲染成表格，不做任何请求、不发事件，
 * 保证两个识别模块的「结果展示」永远长得一样。
 */
import { computed } from 'vue'

const props = defineProps({
  /** 归一化后的识别结果数组 */
  results: {
    type: Array,
    default: () => [],
  },
  /** 当前使用的相似度阈值，用于在表头提示判定标准 */
  threshold: {
    type: Number,
    default: 0.6,
  },
})

/** 命中人数：matched 为 true 表示在特征库里比中了某个已录入人员 */
const matchedCount = computed(() => props.results.filter((item) => item.matched).length)

/**
 * 相似度展示：后端保留 4 位小数，null 表示该人脸没参与比对（特征提取失败等）
 * @param {number|null} value
 */
function similarityText(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return Number(value).toFixed(4)
}

/**
 * 人脸框展示成 "x, y · 宽×高"，方便对照后端日志排查检测问题
 * @param {{x:number,y:number,w:number,h:number}|null} bbox
 */
function bboxText(bbox) {
  if (!bbox) return '—'
  return `${Math.round(bbox.x)}, ${Math.round(bbox.y)} · ${Math.round(bbox.w)}×${Math.round(bbox.h)}`
}
</script>

<template>
  <!-- 没有任何人脸时给空态，而不是渲染一张空表 -->
  <div v-if="results.length === 0" class="empty">
    <span class="empty-mark" aria-hidden="true">🙈</span>
    未检测到人脸
  </div>

  <div v-else>
    <!-- 汇总条：检测到几张人脸、其中几张比中了特征库 -->
    <div class="row-between summary">
      <div class="row">
        <span class="badge badge-neutral">检测到 {{ results.length }} 张人脸</span>
        <span class="badge" :class="matchedCount > 0 ? 'badge-ok' : 'badge-err'">
          命中 {{ matchedCount }} / {{ results.length }}
        </span>
      </div>
      <span class="text-muted">相似度阈值 ≥ {{ threshold.toFixed(2) }} 判定为同一人</span>
    </div>

    <table class="table">
      <thead>
        <tr>
          <th style="width: 56px">#</th>
          <th>识别结果</th>
          <th style="width: 110px">相似度</th>
          <th style="width: 160px">人脸框 (x, y · w×h)</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(item, index) in results" :key="index">
          <td class="text-muted">{{ index + 1 }}</td>
          <td>
            <span v-if="item.matched" class="badge badge-ok">✓ {{ item.name }}</span>
            <span v-else class="badge badge-err">未识别</span>
          </td>
          <td class="mono" :class="item.matched ? 'text-ok' : 'text-muted'">
            {{ similarityText(item.similarity) }}
          </td>
          <td class="mono text-muted nowrap">{{ bboxText(item.bbox) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.summary {
  margin-bottom: 10px;
  font-size: 12.5px;
}

/* 结果少的时候表格底部留白更自然 */
.table {
  border-top: 1px solid var(--line);
}
</style>
