/**
 * Vue 应用入口
 * ---------------------------------------------------------------------------
 * 职责只有三件事：
 *   1. 引入全局样式（设计变量 + 通用组件样式），保证所有模块视觉一致；
 *   2. 创建 Vue 应用实例并挂载到 index.html 的 #app 节点；
 *   3. 预留全局错误兜底：别人写模块时抛出的未捕获异常，统一打日志，
 *      避免某个子模块报错直接白屏却无任何线索。
 */
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'

const app = createApp(App)

/**
 * 全局错误处理器
 * 说明：Vue 组件生命周期 / 事件回调中抛出的异常会走到这里。
 * 这里只做日志上报（本项目无监控平台），关键是不要把异常再抛出去，
 * 否则会打断 Vue 的渲染队列，表现为页面局部不更新。
 */
app.config.errorHandler = (err, instance, info) => {
  console.error('[前端全局异常]', err)
  console.error('[出错组件]', instance?.$options?.name || instance)
  console.error('[出错阶段]', info)
}

// 生产环境关闭 Vue 的性能/警告调试信息，控制台更干净
app.config.performance = import.meta.env.DEV

app.mount('#app')
