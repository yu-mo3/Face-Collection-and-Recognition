<script setup>
/**
 * AppIcon.vue —— 统一的内联 SVG 图标
 * ---------------------------------------------------------------------------
 * 为什么不用 emoji 或图标库：
 *   - emoji 在不同系统字号/字重不一致，页面里大小参差，且颜色无法跟随主题；
 *   - 引图标库（如 element-plus/icons、lucide）会给这个很轻的实训项目多加一个依赖，
 *     还会带来打包体积。
 * 所以这里内置一组 24×24、线性描边、`stroke="currentColor"` 的图标：
 *   - 颜色继承父级 color（卡片标题里自动变主色，危险按钮里自动变红）；
 *   - 尺寸由 size 决定，视觉重量一致；
 *   - aria-hidden 固定为 true —— 图标纯装饰，语义由相邻文字或 aria-label 承担。
 *
 * 实现说明：
 *   ICONS 里存的是**静态** SVG 内部标记，用于 v-html 渲染。
 *   内容全部是本文件内写死的常量，不来自接口、不来自用户输入，不存在 XSS 风险。
 *   之所以用 v-html 而不是把每种图标写成 <path> 数组，是因为部分图标需要
 *   <circle>/<rect>/<ellipse> 混排，用字符串最直观、也最好维护。
 */
import { computed } from 'vue'

const props = defineProps({
  /** 图标名，见下方 ICONS 的键 */
  name: { type: String, required: true },
  /** 显示尺寸（像素），宽高一致 */
  size: { type: [Number, String], default: 18 },
  /** 描边粗细。小尺寸（14~16）建议 2，大尺寸建议 1.8 */
  strokeWidth: { type: [Number, String], default: 1.8 },
})

const ICONS = {
  /* ---------- 模块导航 ---------- */
  // 图片：相框 + 山 + 太阳
  image:
    '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M20.5 16.5 15 11l-8.5 9"/>',
  // 摄像头：机身 + 镜头 + 顶部凸起
  camera:
    '<rect x="2.5" y="6.5" width="19" height="13.5" rx="3.5"/><circle cx="12" cy="13.2" r="3.6"/><path d="M8.5 6.5 10 3.8h4l1.5 2.7"/>',
  // 人脸录入：人像 + 右下加号
  'user-plus':
    '<circle cx="10" cy="8" r="3.8"/><path d="M3 20.2c0-3.7 3.1-6.2 7-6.2 1.3 0 2.5.3 3.5.8"/><path d="M18.5 14.5v6M15.5 17.5h6"/>',
  // 特征库：数据库三层柱体
  database:
    '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v6c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-6"/><path d="M4 11.5v6c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-6"/>',

  /* ---------- 品牌与识别 ---------- */
  // 人脸扫描框：四个角 + 微笑 + 双眼
  'scan-face':
    '<path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9"/><path d="M20 9V6.5A2.5 2.5 0 0 0 17.5 4H15"/><path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20H9"/><path d="M20 15v2.5A2.5 2.5 0 0 1 17.5 20H15"/><path d="M9.2 10.2v1.4M14.8 10.2v1.4"/><path d="M9.4 14.6c.8.7 1.7 1.1 2.6 1.1s1.8-.4 2.6-1.1"/>',

  /* ---------- 动作 ---------- */
  upload: '<path d="M12 15.5V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M20 20l-4.4-4.4"/>',
  refresh:
    '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.2 4.5v5h-5"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.2 7l.9 11.3A1.7 1.7 0 0 0 8.8 20h6.4a1.7 1.7 0 0 0 1.7-1.7L17.8 7"/><path d="M10.3 11v5M13.7 11v5"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  'arrow-right': '<path d="M4.5 12h15"/><path d="M13.5 6 19.5 12l-6 6"/>',
  x: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  play: '<path d="M7.5 4.8 19 12 7.5 19.2z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  // 抓拍：圆环 + 内圈
  shutter: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="3.4"/>',
  // 连续识别：循环箭头
  repeat:
    '<path d="M4 12a8 8 0 0 1 13.6-5.7"/><path d="M20 4.4v4.8h-4.8"/><path d="M20 12a8 8 0 0 1-13.6 5.7"/><path d="M4 19.6v-4.8h4.8"/>',

  /* ---------- 状态 ---------- */
  alert:
    '<path d="M12 3.6 2.6 20h18.8z"/><path d="M12 9.6v4.2"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/>',
  // 未检测到人脸：空框
  'face-none':
    '<rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke-dasharray="3.5 3"/><path d="M9.2 10.5v1M14.8 10.5v1"/><path d="M9.5 15.5c.7.6 1.5.9 2.5.9s1.8-.3 2.5-.9"/>',
  // 空库：抽屉
  inbox:
    '<path d="M3.5 12.5h4l1.5 2.5h6l1.5-2.5h4"/><path d="M5.6 5.2h12.8a2 2 0 0 1 1.9 1.4l1.2 5.9v3a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2v-3l1.2-5.9a2 2 0 0 1 1.9-1.4z"/>',
  // 空结果：目镜
  'empty-target': '<circle cx="12" cy="12" r="8.4" stroke-dasharray="3.5 3"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  'clock': '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 1.9"/>',
}

const markup = computed(() => ICONS[props.name] || '')
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="markup"
  />
</template>

<style scoped>
/* 行内对齐：图标默认与文字基线对齐会偏低，用垂直对齐修正 */
.icon {
  display: inline-block;
  vertical-align: -0.15em;
  flex: none;
}
</style>
