<script setup>
/**
 * App.vue —— 应用外壳
 * ---------------------------------------------------------------------------
 * 只做三件事，业务逻辑全部在 src/views/ 各模块里：
 *   1. 顶部标识区：品牌图标 + 系统名 + 右侧能力标签；
 *   2. 模块导航：分段式标签栏，activeTab 记录当前模块；
 *   3. 内容区：按 activeTab 渲染对应视图组件。
 *
 * UI 约定：
 *   - 顶部只保留"是什么"，不写技术栈/调用方式这类实现说明；
 *   - 内容区宽度由 .app-shell 统一控制（大屏尽量铺满，减少两侧空白）。
 *
 * 其他结构性约定：
 *   - 内容区顶部不重复"模块名 + 说明"：标签栏已显示模块名，每张卡片自己也有标题，
 *     三层重复信息会把页面压得很挤。模块说明挂在标签 title 上（悬停可见）。
 *   - 图标统一用 AppIcon 内联 SVG，尺寸/颜色/描边一致。
 *   - 标签与 URL hash 同步（#upload / #camera / #register / #features），
 *     刷新、分享链接都能停在同一个模块；用 replaceState 写入，不污染前进后退历史。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import AppIcon from './components/AppIcon.vue'

// 业务视图组件：一个模块一个文件，互不引用
import UploadRecognize from './views/UploadRecognize.vue'
import CameraRecognize from './views/CameraRecognize.vue'
import RegisterFace from './views/RegisterFace.vue'
import FeatureLibrary from './views/FeatureLibrary.vue'

/**
 * 模块清单
 * key     —— 唯一标识，同时用作 URL hash
 * label   —— 导航文字
 * icon    —— AppIcon 的图标名
 * summary —— 一句话说明，只作为标签的 title 提示，不再单独占一行
 */
const tabs = [
  { key: 'upload', label: '图片识别', icon: 'image', summary: '上传本地图片（≤5MB），识别图中每一张人脸' },
  { key: 'camera', label: '摄像头识别', icon: 'camera', summary: '调用摄像头抓帧，Base64 上传实时识别' },
  { key: 'register', label: '人脸录入', icon: 'user-plus', summary: '上传人脸图片 + 姓名，写入特征库' },
  { key: 'features', label: '特征库', icon: 'database', summary: '查看已录入人员，支持按姓名删除' },
]

/**
 * key → 视图组件。用映射表 + <component :is> 而不是 v-if 链：
 * 新增模块只需在 tabs 和 viewMap 各加一行，模板不用动。
 */
const viewMap = {
  upload: UploadRecognize,
  camera: CameraRecognize,
  register: RegisterFace,
  features: FeatureLibrary,
}

/** 合法模块 key 集合，用于校验 hash */
const validKeys = new Set(tabs.map((tab) => tab.key))

/**
 * 从 URL hash 解析初始模块。
 * 例如访问 /#camera 时直接打开摄像头模块；hash 非法则回落到第一个模块。
 * @returns {string}
 */
function readTabFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, '').trim()
  return validKeys.has(raw) ? raw : tabs[0].key
}

// 当前选中的模块
const activeTab = ref(readTabFromHash())

/** 当前模块对应的视图组件 */
const activeView = computed(() => viewMap[activeTab.value] || null)

/**
 * 切换模块并同步 hash。
 * @param {string} key 目标模块 key
 */
function switchTab(key) {
  if (!validKeys.has(key) || activeTab.value === key) return
  activeTab.value = key
  // 用 replaceState 而不是给 location.hash 赋值：后者每切一次都压一条历史记录，
  // 用户点后退会逐个倒着退模块，体验很差
  if (window.location.hash !== `#${key}`) {
    window.history.replaceState(null, '', `#${key}`)
  }
}

/**
 * 监听外部 hash 变化（手动改地址栏、浏览器前进后退）。
 * 内部切换用 replaceState 不会触发该事件，所以不会和 switchTab 打架。
 */
function onHashChange() {
  const next = readTabFromHash()
  if (next !== activeTab.value) activeTab.value = next
}

/**
 * 「人脸录入」模块的事件回调。
 * RegisterFace 用 registered 事件广播两件事：
 *   - payload 为对象：录入成功，仅通知，不切页（否则用户看不到成功提示就被跳走）；
 *   - payload 为 null：用户点了「去特征库查看」，此时切到特征库。
 * @param {{recordId:number|null,name:string}|null} payload
 */
function onRegistered(payload) {
  if (payload === null) switchTab('features')
}

onMounted(() => {
  // 首次进入时把默认模块也写进 hash，保证地址栏状态与界面一致
  if (window.location.hash !== `#${activeTab.value}`) {
    window.history.replaceState(null, '', `#${activeTab.value}`)
  }
  window.addEventListener('hashchange', onHashChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
})
</script>

<template>
  <div class="app-shell">
    <!-- ================= 标识区 ================= -->
    <header class="app-head">
      <div class="identity">
        <div class="logo">
          <AppIcon name="scan-face" :size="22" :stroke-width="1.7" />
        </div>
        <div class="identity-text">
          <h1 class="app-title">人脸采集与识别系统</h1>
        </div>
      </div>

      <div class="head-meta">
        <span class="meta-chip"><i class="dot dot-brand"></i>Haar 人脸检测</span>
        <span class="meta-chip"><i class="dot dot-ok"></i>FaceNet 512 维特征</span>
      </div>
    </header>

    <!-- ================= 模块导航 ================= -->
    <nav class="tabbar" aria-label="功能模块导航">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        :title="tab.summary"
        :aria-current="activeTab === tab.key ? 'page' : undefined"
        @click="switchTab(tab.key)"
      >
        <AppIcon :name="tab.icon" :size="16" :stroke-width="1.9" />
        <span class="tab-label">{{ tab.label }}</span>
      </button>
    </nav>

    <!-- ================= 内容区 ================= -->
    <main class="content">
      <!--
        :key="activeTab" 保证切换模块时组件销毁重建：
        摄像头模块必须在离开时释放 MediaStream，重建语义最不容易出错。
      -->
      <component :is="activeView" v-if="activeView" :key="activeTab" @registered="onRegistered" />

      <!-- 未映射模块的防御性兜底 -->
      <section v-else class="card">
        <div class="empty">
          <span class="empty-mark"><AppIcon name="empty-target" :size="22" /></span>
          <p class="empty-title">该模块正在接入中</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* ================= 标识区 ================= */
.app-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.identity {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
}

.logo {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: linear-gradient(150deg, #5b54ea, #7c3aed);
  color: #fff;
  flex: none;
  box-shadow: 0 8px 18px -12px rgba(79, 70, 229, 0.95);
}

.identity-text {
  min-width: 0;
}

/* 标题：去掉了原来的技术栈说明副标题，字号相应放大，让它成为明确的页面标题 */
.app-title {
  font-size: 22px;
  letter-spacing: -0.02em;
  line-height: 1.25;
}

/* 能力标签：纯文字 + 小圆点，不用胶囊包裹，降低视觉噪音 */
.head-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.dot-brand {
  background: var(--brand);
}

.dot-ok {
  background: #16a34a;
}

/* ================= 模块导航 ================= */
.tabbar {
  display: flex;
  gap: 2px;
  padding: 5px;
  margin-bottom: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: var(--shadow-sm);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  /* 隐藏横向滚动条，窄屏时靠滑动切换 */
  scrollbar-width: none;
}

.tabbar::-webkit-scrollbar {
  display: none;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition: background var(--t), color var(--t), border-color var(--t), box-shadow var(--t);
}

.tab:hover:not(.active) {
  background: #f4f5f8;
  color: var(--ink-soft);
}

/* 选中态：白底 + 细描边 + 轻投影，比整块实心色更克制，
   也让主色留给页面里的主按钮 */
.tab.active {
  border-color: var(--line);
  background: #fff;
  color: var(--brand-dark);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 4px 10px -8px rgba(16, 24, 40, 0.2);
}

.tab.active .icon {
  color: var(--brand);
}

/* ================= 响应式 ================= */
/* 窄屏：能力标签换行到标题下方，避免挤压标题 */
@media (max-width: 720px) {
  .app-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
}

/*
  手机宽度下四个标签必须全部可见：
  默认的固定内边距会让总宽超出容器，触发横向滚动，
  结果是第 4 个标签被裁在可视区外（看不出还有一页）。
  这里改为等分宽度 + 收紧内边距和字号，保证一行放下四个。
*/
@media (max-width: 640px) {
  .tabbar {
    gap: 2px;
    padding: 3px;
  }

  .tab {
    flex: 1 1 0;
    min-width: 0;
    justify-content: center;
    padding: 0 8px;
    font-size: 13px;
    gap: 5px;
  }

  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/*
  超窄屏（<=460px）：四个标签等分后每个只有 80~97px，
  而"摄像头识别"有 5 个汉字，图标再占 21px 就会被省略号截断。
  图标在这里纯属装饰，标签文字本身含义明确，所以窄屏直接隐藏图标换回文字宽度。
*/
@media (max-width: 460px) {
  .tab {
    padding: 0 6px;
    font-size: 12.5px;
  }

  .tab .icon {
    display: none;
  }
}
</style>
