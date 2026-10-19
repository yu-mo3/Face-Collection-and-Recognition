<script setup>
/**
 * FeatureLibrary.vue —— 模块四：特征库管理（查看 + 删除）
 * ---------------------------------------------------------------------------
 * 对应后端两个接口：
 *   GET    /api/features          → { count, items: [{ id, name }] }
 *   DELETE /api/features/{name}   → { deleted, name }；无该姓名时 404
 *
 * 后端数据来源：core/db_utils.py 的 face_features 表，一行 = 一个人的一张脸特征。
 * save_feature() 对同名会跳过，正常状态下姓名唯一；但删除接口返回的 deleted 是
 * 「条数」，界面直接用它告诉用户实际删掉了几条。
 *
 * 两个关键设计：
 *   1. 删除用「行内二次确认」而不是 window.confirm：原生 confirm 阻塞渲染、
 *      样式不可控，行内确认更清晰也不易误触；
 *   2. 删除成功后重新拉取全量列表，而不是本地 splice —— 以服务端为准，
 *      避免本地状态与 SQLite 不一致。
 *
 * 本次视觉优化：
 *   - 工具栏：搜索框加前置图标，右侧计数改为纯文字 + 图标刷新按钮，去掉拥挤的胶囊；
 *   - 列表：姓名前加首字圆形头像，记录 ID 用弱化的等宽字体（它是次要信息）；
 *   - 空态 / 无匹配 / 加载中三种状态分开呈现，文案不再混用。
 */
import { computed, onMounted, ref } from 'vue'

import AppIcon from '../components/AppIcon.vue'
import { deleteFeature, listFeatures } from '../api/face'

/* ===================== 状态 ===================== */

/** 记录列表 [{ id, name }] */
const items = ref([])
/** 服务端总条数 */
const count = ref(0)
/** 加载中 */
const loading = ref(false)
/** 是否成功加载过（区分"还没加载"和"确实为空"） */
const loaded = ref(false)
/** 错误提示 */
const errorMsg = ref('')
/** 成功提示 */
const infoMsg = ref('')
/** 姓名筛选关键字 */
const filter = ref('')
/** 待确认删除的姓名；null 表示没有待确认项 */
const pendingDelete = ref(null)
/** 删除请求进行中 */
const deleting = ref(false)

/* ===================== 派生状态 ===================== */

/**
 * 按姓名筛选后的列表。
 * 特征库通常只有几十条，前端过滤足够；数据量大时应改成后端分页/搜索。
 */
const filteredItems = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  if (!keyword) return items.value
  return items.value.filter((item) => item.name.toLowerCase().includes(keyword))
})

/** 库为空（加载完成 + 无记录） */
const isEmpty = computed(() => loaded.value && items.value.length === 0)

/** 筛选了但没结果 */
const filtered = computed(() => filter.value.trim().length > 0)

/** 筛选无匹配 */
const noMatch = computed(
  () => !isEmpty.value && filteredItems.value.length === 0 && filtered.value
)

/* ===================== 数据加载 ===================== */

/**
 * 拉取特征库。
 * @param {{silent?: boolean}} [options] silent=true 时不显示加载态（用于删除后刷新）
 */
async function load({ silent = false } = {}) {
  if (!silent) loading.value = true
  errorMsg.value = ''

  try {
    const res = await listFeatures()
    items.value = res.items
    count.value = res.count
    loaded.value = true
  } catch (e) {
    errorMsg.value = e.message || '获取特征库失败'
  } finally {
    loading.value = false
  }
}

/** 手动刷新：清掉提示再拉 */
async function refresh() {
  infoMsg.value = ''
  pendingDelete.value = null
  await load()
}

/* ===================== 删除 ===================== */

/**
 * 点某行的删除：进入待确认状态。
 * pendingDelete 只存一个姓名，点另一行会把确认状态转移过去。
 * @param {string} name
 */
function askDelete(name) {
  infoMsg.value = ''
  errorMsg.value = ''
  pendingDelete.value = name
}

function cancelDelete() {
  pendingDelete.value = null
}

/**
 * 确认删除：DELETE /api/features/{name}。
 * 后端按姓名删除，会删掉该姓名下的所有记录。
 * @param {string} name
 */
async function confirmDelete(name) {
  if (deleting.value) return
  deleting.value = true
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const res = await deleteFeature(name)
    pendingDelete.value = null
    infoMsg.value = `已删除「${res.name}」的 ${res.deleted} 条特征记录`
    await load({ silent: true })
  } catch (e) {
    // 404 场景（例如别处已删掉同一条）：提示即可，不当严重错误
    errorMsg.value = e.message || '删除失败'
    pendingDelete.value = null
    await load({ silent: true })
  } finally {
    deleting.value = false
  }
}

/** 清空筛选 */
function clearFilter() {
  filter.value = ''
}

/** 首次进入即加载（组件是 v-if 渲染的，每次切到本标签都会重新挂载并刷新） */
onMounted(() => {
  load()
})
</script>

<template>
  <div class="fade-in">
    <section class="card">
      <!-- ==================== 头部 ==================== -->
      <div class="card-head">
        <div>
          <div class="card-title">
            <AppIcon name="database" :size="17" />
            特征库
          </div>
          <p class="card-desc">
            SQLite <code>face_features</code> 表，每条记录对应一个人的 512 维人脸特征
          </p>
        </div>

        <div class="row">
          <span class="meta-text">
            <template v-if="loaded">共 <b class="count-num">{{ count }}</b> 条</template>
            <template v-else>尚未加载</template>
          </span>
          <button type="button" class="icon-btn" title="刷新" aria-label="刷新特征库" :disabled="loading" @click="refresh">
            <span v-if="loading" class="spinner" aria-hidden="true"></span>
            <AppIcon v-else name="refresh" :size="16" />
          </button>
        </div>
      </div>

      <!-- ==================== 工具栏 ==================== -->
      <div class="toolbar">
        <div class="input-wrap search">
          <AppIcon name="search" :size="15" />
          <input
            v-model="filter"
            class="input"
            type="search"
            placeholder="按姓名筛选…"
            :disabled="isEmpty"
          />
        </div>
        <span v-if="filtered && !isEmpty" class="meta-text">
          {{ filteredItems.length }} / {{ items.length }} 条匹配
          <button type="button" class="link-btn" @click="clearFilter">清空</button>
        </span>
      </div>

      <!-- 概览：把关键事实提到列表上方。
           记录很少时也能让页面有稳定的信息骨架，不至于只剩一行表格和一大片空白 -->
      <div v-if="loaded && !isEmpty" class="stats overview">
        <div class="stat-block">
          <span class="stat-key">记录总数</span>
          <span class="stat-val">{{ count }}</span>
        </div>
        <div class="stat-block">
          <span class="stat-key">特征维度</span>
          <span class="stat-val">512</span>
        </div>
        <div class="stat-block">
          <span class="stat-key">数据表</span>
          <span class="stat-val" title="core/face_features.db → 表 face_features">face_features</span>
        </div>
      </div>

      <!-- ==================== 提示 ==================== -->
      <div v-if="errorMsg" class="alert alert-err" role="alert">
        <AppIcon name="alert" :size="15" />
        <span>{{ errorMsg }}</span>
      </div>
      <div v-if="infoMsg" class="alert alert-ok" role="status">
        <AppIcon name="check" :size="15" :stroke-width="2.2" />
        <span>{{ infoMsg }}</span>
      </div>

      <!-- ==================== 列表 ==================== -->
      <div v-if="loading && !loaded" class="loading">
        <span class="spinner" aria-hidden="true"></span>
        正在读取特征库……
      </div>

      <div v-else-if="isEmpty" class="empty">
        <span class="empty-mark"><AppIcon name="inbox" :size="22" /></span>
        <p class="empty-title">特征库还是空的</p>
        <p class="hint">先到「人脸录入」标签上传一张人脸图片，这里就会出现记录</p>
      </div>

      <div v-else-if="noMatch" class="empty">
        <span class="empty-mark"><AppIcon name="search" :size="22" /></span>
        <p class="empty-title">没有匹配的姓名</p>
        <p class="hint">
          没有包含「{{ filter.trim() }}」的记录，
          <button type="button" class="link-btn" @click="clearFilter">清空筛选</button>
        </p>
      </div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="col-num">ID</th>
              <th>姓名</th>
              <th class="col-right" style="width: 168px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredItems" :key="item.id">
              <td class="col-num">{{ item.id }}</td>

              <td>
                <span class="person">
                  <span class="avatar" aria-hidden="true">{{ item.name.slice(0, 1) }}</span>
                  <span class="person-name">{{ item.name }}</span>
                </span>
              </td>

              <!-- 行内二次确认：后端按姓名删，删了就得重录，所以要点两下 -->
              <td class="col-right">
                <template v-if="pendingDelete === item.name">
                  <div class="row-end">
                    <button type="button" class="btn btn-sm btn-ghost" :disabled="deleting" @click="cancelDelete">
                      取消
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-danger"
                      :disabled="deleting"
                      @click="confirmDelete(item.name)"
                    >
                      <span v-if="deleting" class="spinner" aria-hidden="true"></span>
                      <AppIcon v-else name="trash" :size="13" />
                      确认删除
                    </button>
                  </div>
                </template>
                <button
                  v-else
                  type="button"
                  class="btn btn-sm btn-ghost delete-btn"
                  @click="askDelete(item.name)"
                >
                  <AppIcon name="trash" :size="13" />
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="foot-hint">
        删除按姓名进行：该姓名下的所有特征记录都会被移除，之后需要重新录入。
      </p>
    </section>
  </div>
</template>

<style scoped>
/* ---------- 工具栏 ---------- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.search {
  width: 260px;
  max-width: 100%;
}

.count-num {
  color: var(--ink);
  font-family: 'Cascadia Code', Consolas, Monaco, monospace;
  font-weight: 600;
}

.link-btn {
  padding: 0;
  margin-left: 4px;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
}

.link-btn:hover {
  text-decoration: underline;
}

/* 提示条与列表之间留一点空 */
.alert + .table-wrap,
.alert + .empty,
.alert + .loading {
  margin-top: 12px;
}

/* 概览条与列表之间的间距 */
.overview {
  margin-bottom: 14px;
}

/* ---------- 姓名列 ---------- */
.person {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

/* 首字头像：纯 CSS，无图片资源，列表扫读时能快速定位 */
.avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-dark);
  font-size: 12px;
  font-weight: 700;
  flex: none;
}

.person-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 删除按钮默认克制，悬停才变红 —— 避免整列红色抢注意力 */
.delete-btn {
  color: var(--muted);
}

.delete-btn:hover:not(:disabled) {
  background: var(--err-soft);
  color: var(--err);
}

/* ---------- 表尾说明 ---------- */
.foot-hint {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 12px;
}
</style>
