<script setup>
/**
 * App.vue —— 应用外壳（页面骨架）
 * ---------------------------------------------------------------------------
 * 本文件只负责「壳」的三件事，业务逻辑全部下放到 src/views/ 的各模块里：
 *   1. 顶部品牌栏：标题 + 后端接口地址说明，让使用者一眼知道连的是哪个服务；
 *   2. 模块导航：每个标签对应一个业务模块（图片识别 / 摄像头识别 / 人脸录入 /
 *      特征库管理），用 activeTab 记录当前选中项；
 *   3. 内容区：根据 activeTab 渲染对应视图组件。
 *
 * 说明：骨架阶段先把导航和内容容器立起来，各业务模块会在后续提交中逐个接入。
 */
import { computed, ref } from 'vue'

// 业务视图组件：每个模块一个文件，互不耦合
import UploadRecognize from './views/UploadRecognize.vue'
import CameraRecognize from './views/CameraRecognize.vue'

/**
 * 模块清单
 * key      —— 唯一标识，用于 activeTab 与组件的匹配
 * label    —— 导航栏显示文字
 * icon     —— 导航栏图标（emoji，免去引入图标库）
 * summary  —— 一句话说明，展示在内容区顶部
 */
const tabs = [
  { key: 'upload', label: '图片识别', icon: '🖼️', summary: '上传本地图片（≤5MB），识别图中每一张人脸' },
  { key: 'camera', label: '摄像头识别', icon: '📷', summary: '调用摄像头抓帧，Base64 上传实时识别' },
  { key: 'register', label: '人脸录入', icon: '👤', summary: '上传人脸图片 + 姓名，写入特征库' },
  { key: 'features', label: '特征库', icon: '🗂️', summary: '查看已录入人员，支持按姓名删除' },
]

/**
 * key → 视图组件的映射表。
 * 用映射表 + <component :is> 而不是 v-if 链：
 *   新增模块只需在 tabs 和 viewMap 各加一行，模板不用动。
 * 尚未接入的模块查不到组件，页面会渲染「即将接入」占位卡片。
 */
const viewMap = {
  upload: UploadRecognize,
  camera: CameraRecognize,
}

// 当前选中的模块，默认第一个「图片识别」
const activeTab = ref('upload')

/** 当前模块的元信息（标题、说明），用于内容区顶部的一行介绍 */
const activeMeta = computed(() => tabs.find((tab) => tab.key === activeTab.value) || tabs[0])

/** 当前模块对应的视图组件，未接入时为 null */
const activeView = computed(() => viewMap[activeTab.value] || null)

/**
 * 切换模块
 * @param {string} key 目标模块的 key
 */
function switchTab(key) {
  if (activeTab.value !== key) {
    activeTab.value = key
  }
}
</script>

<template>
  <div class="app-shell">
    <!-- ================= 顶部品牌栏 ================= -->
    <header class="brand">
      <div class="brand-left">
        <div class="brand-logo">人脸</div>
        <div>
          <h1 class="page-title">人脸采集与识别系统</h1>
          <p class="page-subtitle">
            Vue3 + Vite 前端 · 对接 FastAPI 后端
            <code>/api</code> 路由 · 单张图片上传上限 <strong>5MB</strong>
          </p>
        </div>
      </div>
      <div class="brand-meta">
        <span class="badge badge-neutral">Haar 检测</span>
        <span class="badge badge-neutral">FaceNet 特征比对</span>
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
        :aria-current="activeTab === tab.key ? 'page' : undefined"
        @click="switchTab(tab.key)"
      >
        <span class="tab-icon" aria-hidden="true">{{ tab.icon }}</span>
        {{ tab.label }}
      </button>
    </nav>

    <!-- ================= 内容区 ================= -->
    <main class="content">
      <!-- 当前模块标题与一句话说明，切换标签时同步变化 -->
      <div class="module-intro">
        <h2 class="module-title">
          <span aria-hidden="true">{{ activeMeta.icon }}</span>
          {{ activeMeta.label }}
        </h2>
        <p class="module-summary">{{ activeMeta.summary }}</p>
      </div>

      <!--
        业务视图挂载点。
        :key="activeTab" 保证切换模块时组件被销毁重建：
        摄像头模块必须在离开时释放 MediaStream，重建语义最不容易出错。
      -->
      <component :is="activeView" v-if="activeView" :key="activeTab" />

      <!-- 尚未接入的模块占位 -->
      <section v-else class="card">
        <div class="empty">
          <span class="empty-mark" aria-hidden="true">🚧</span>
          该模块正在接入中
        </div>
      </section>
    </main>

    <footer class="foot">
      人脸检测识别系统（实训版）· 后端 <code>app.py</code> 提供 /api 接口，前端仅通过 HTTP 调用，不修改后端逻辑
    </footer>
  </div>
</template>

<style scoped>
/* ================= 品牌栏 ================= */
.brand {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.brand-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

/* 左侧方形标识块：纯 CSS 渐变，避免额外图片资源 */
.brand-logo {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 13px;
  background: linear-gradient(135deg, #4361ee, #7c3aed);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: 0 8px 20px -10px rgba(67, 97, 238, 0.9);
  flex: none;
}

.brand-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 4px;
}

/* ================= 模块导航 ================= */
.tabbar {
  display: flex;
  gap: 4px;
  padding: 5px;
  margin-bottom: 18px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
  overflow-x: auto;
  /* iOS 惯性滚动，窄屏横向滚动更顺滑 */
  -webkit-overflow-scrolling: touch;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 16px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--ink-soft);
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.tab:hover {
  background: #eef2ff;
  color: var(--brand-dark);
}

.tab.active {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 6px 16px -8px rgba(67, 97, 238, 0.95);
}

.tab-icon {
  font-size: 15px;
  line-height: 1;
}

/* ================= 内容区模块介绍 ================= */
.module-intro {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding-left: 2px;
}

.module-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 16px;
}

.module-summary {
  color: var(--muted);
  font-size: 12.5px;
}

/* ================= 页脚 ================= */
.foot {
  margin-top: 28px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}
</style>
