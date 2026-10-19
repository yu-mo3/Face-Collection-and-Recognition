<script setup>
/**
 * FeatureLibrary.vue —— 模块四：特征库管理（查看 + 删除）
 * ---------------------------------------------------------------------------
 * 对应后端两个接口：
 *   GET    /api/features          → { count, items: [{ id, name }] }
 *   DELETE /api/features/{name}   → { deleted, name }；无该姓名时 404
 *
 * 后端数据来源：core/db_utils.py 的 face_features 表，一行 = 一个人的一张脸特征。
 * 由于 save_feature() 对同名会跳过，正常状态下姓名唯一；但历史上可能存在同名多条
 * （例如手工灌库），所以删除接口返回的 deleted 是「条数」而不是 0/1，
 * 界面用这个数字告诉用户实际删掉了几条。
 *
 * 本模块的两个关键设计：
 *   1. 删除采用「行内二次确认」而不是 window.confirm：
 *      原生 confirm 会阻塞渲染、样式不可控，行内确认更清晰也不易误触；
 *   2. 每次删除成功后重新拉取全量列表，而不是本地 splice 掉那一行 ——
 *      以服务端为准，避免本地状态和后端库不一致。
 */
import { computed, onMounted, ref } from 'vue'

import { deleteFeature, listFeatures } from '../api/face'

/* ===================== 状态 ===================== */

/** 特征库记录列表 [{ id, name }] */
const items = ref([])
/** 服务端返回的总条数 */
const count = ref(0)
/** 首次/手动加载中 */
const loading = ref(false)
/** 是否已经成功加载过（用来区分"还没加载"和"确实为空"） */
const loaded = ref(false)
/** 错误提示 */
const errorMsg = ref('')
/** 操作成功提示（删除成功等） */
const infoMsg = ref('')
/** 姓名筛选关键字 */
const filter = ref('')
/** 正在等待确认删除的姓名；null 表示没有待确认项 */
const pendingDelete = ref(null)
/** 删除请求进行中 */
const deleting = ref(false)

/* ===================== 派生状态 ===================== */

/**
 * 按姓名筛选后的列表。
 * 特征库通常只有几十条，前端过滤足够；数据量大时应该改成后端分页/搜索。
 */
const filteredItems = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  if (!keyword) return items.value
  return items.value.filter((item) => item.name.toLowerCase().includes(keyword))
})

/** 是否处于"库为空"状态（加载完成 + 无记录） */
const isEmpty = computed(() => loaded.value && items.value.length === 0)

/** 筛选了但没结果 */
const noMatch = computed(
  () => !isEmpty.value && filteredItems.value.length === 0 && filter.value.trim().length > 0
)

/* ===================== 数据加载 ===================== */

/**
 * 拉取特征库。
 * @param {{silent?: boolean}} [options] silent=true 时加载中不闪 loading 态（用于删除后刷新）
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
 * 点击某行的「删除」：进入待确认状态。
 * 同时点另一行会把确认状态转移过去（pendingDelete 只存一个姓名）。
 * @param {string} name
 */
function askDelete(name) {
  infoMsg.value = ''
  errorMsg.value = ''
  pendingDelete.value = name
}

/** 取消删除 */
function cancelDelete() {
  pendingDelete.value = null
}

/**
 * 确认删除：调用 DELETE /api/features/{name}。
 * 注意后端是按姓名删除，会删掉该姓名下的所有记录。
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
    // 以服务端为准重新拉取，避免本地状态与 SQLite 不一致
    await load({ silent: true })
  } catch (e) {
    // 404 场景：例如另一个人同时删掉了同一条，提示即可，不必当成严重错误
    errorMsg.value = e.message || '删除失败'
    pendingDelete.value = null
    // 失败后也刷新一次，让界面反映服务端真实状态
    await load({ silent: true })
  } finally {
    deleting.value = false
  }
}

/** 首次进入即加载（子组件是 v-if 渲染的，每次切到本标签都会重新挂载并刷新） */
onMounted(() => {
  load()
})
</script>

<template>
  <div class="fade-in">
    <!-- ==================== 顶部工具栏 ==================== -->
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title"><span aria-hidden="true">🗂️</span> 特征库</div>
          <p class="card-desc">
            来自后端 SQLite 的 <code>face_features</code> 表，每条记录对应一个人的 512 维人脸特征
          </p>
        </div>

        <div class="row">
          <span class="badge badge-neutral">
            {{ loaded ? `共 ${count} 条记录` : '尚未加载' }}
          </span>
          <button type="button" class="btn btn-sm" :disabled="loading" @click="refresh">
            <span v-if="loading" class="spinner" aria-hidden="true"></span>
            <span v-else aria-hidden="true">↻</span>
            刷新
          </button>
        </div>
      </div>

      <!-- 搜索框：记录多时按姓名快速定位 -->
      <div class="toolbar">
        <input
          v-model="filter"
          class="input search"
          type="search"
          placeholder="按姓名筛选…"
          :disabled="isEmpty"
        />
        <span v-if="filter.trim()" class="text-muted filter-hint">
          {{ filteredItems.length }} / {{ items.length }} 条匹配
        </span>
      </div>

      <!-- 提示区 -->
      <div v-if="errorMsg" class="alert alert-err" role="alert">
        <span aria-hidden="true">⚠️</span>
        <span>{{ errorMsg }}</span>
      </div>
      <div v-if="infoMsg" class="alert alert-ok" role="status">
        <span aria-hidden="true">✅</span>
        <span>{{ infoMsg }}</span>
      </div>

      <!-- 加载中 -->
      <div v-if="loading && !loaded" class="loading">
        <span class="spinner" aria-hidden="true"></span>
        正在读取特征库……
      </div>

      <!-- 空库 -->
      <div v-else-if="isEmpty" class="empty">
        <span class="empty-mark" aria-hidden="true">📭</span>
        <p>特征库还是空的</p>
        <p class="hint">先到「人脸录入」标签上传一张人脸图片，这里就会出现记录</p>
      </div>

      <!-- 筛选无结果 -->
      <div v-else-if="noMatch" class="empty">
        <span class="empty-mark" aria-hidden="true">🔍</span>
        没有包含「{{ filter.trim() }}」的姓名
      </div>

      <!-- 数据表 -->
      <table v-else class="table">
        <thead>
          <tr>
            <th style="width: 90px">记录 ID</th>
            <th>姓名</th>
            <th style="width: 140px" class="col-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredItems" :key="item.id">
            <td class="mono text-muted">{{ item.id }}</td>
            <td>
              <span class="name-cell">
                <span class="avatar" aria-hidden="true">{{ item.name.slice(0, 1) }}</span>
                {{ item.name }}
              </span>
            </td>
            <td class="col-right">
              <!-- 行内二次确认：避免误点删除（后端按姓名删除，删了就没了） -->
              <template v-if="pendingDelete === item.name">
                <button
                  type="button"
                  class="btn btn-sm btn-danger"
                  :disabled="deleting"
                  @click="confirmDelete(item.name)"
                >
                  <span v-if="deleting" class="spinner" aria-hidden="true"></span>
                  确认删除
                </button>
                <button type="button" class="btn btn-sm" :disabled="deleting" @click="cancelDelete">
                  取消
                </button>
              </template>
              <button v-else type="button" class="btn btn-sm btn-danger" @click="askDelete(item.name)">
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <p class="hint foot-hint">
        删除是按姓名进行的：该姓名下的所有特征记录都会被移除，之后需要重新到「人脸录入」录一次。
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
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.search {
  max-width: 280px;
}

.filter-hint {
  font-size: 12px;
}

/* ---------- 表格内姓名列 ---------- */
.name-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

/* 首字母圆形头像：纯 CSS，无图片资源 */
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

/* 操作列按钮之间留一点缝 */
.col-right .btn + .btn {
  margin-left: 6px;
}

.foot-hint {
  margin-top: 14px;
}
</style>
