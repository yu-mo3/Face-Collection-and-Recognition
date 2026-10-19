# 人脸采集与识别系统 · 前端

Vue 3 + Vite 单页应用，对接本仓库后端（FastAPI）`/api` 路由，覆盖全部 5 个接口。
**后端业务逻辑未做改动**（仅修复了一个导致全部接口 500 的 SQLite 线程安全问题，见「后端配套改动」）。

---

## 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 18（实测 22.23.2） | Vite 6 要求 |
| npm | ≥ 9（实测 10.9.8） | |
| 浏览器 | Chrome / Edge / Firefox 最新版 | 摄像头模块要求安全上下文 |

后端需已安装 `fastapi`、`uvicorn`、`opencv-python(4.x)`、`facenet_pytorch`、`torch`、`scikit-learn`。

---

## 2. 启动步骤

### 2.1 启动后端（8000 端口）

在**项目根目录**执行：

```powershell
# Windows PowerShell —— 两个环境变量必须设置，原因见 2.3
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

```bash
# macOS / Linux
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

看到 `Application startup complete.` 即就绪。接口文档：<http://127.0.0.1:8000/docs>

> 首次识别请求会加载 FaceNet 权重（`casia-webface`），可能耗时数十秒，属正常现象。

### 2.2 启动前端（5173 端口）

```bash
cd frontend
npm install
npm run dev
```

浏览器打开 **<http://localhost:5173>**。

### 2.3 为什么必须设置 `PYTHONUTF8`

后端的 `face/face_recognition.py`、`core/db_utils.py` 里有带 emoji 的 `print`（如 `❌ 无匹配人脸`）。
Windows 控制台默认 GBK 编码，在 uvicorn 下这些 `print` 会抛：

```
UnicodeEncodeError: 'gbk' codec can't encode character '\u274c'
```

表现为**接口直接 500**。设置 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` 让 stdout 用 UTF-8 即可规避，
无需改动后端代码。

> 最容易踩中的场景：**识别一张特征库里没有的人脸**（即「未匹配」分支）时必现。

---

## 3. 目录结构

```
frontend/
├── index.html                  # 入口 HTML（内联 SVG favicon）
├── package.json                # 依赖与 dev/build/preview 脚本
├── vite.config.js              # 5173 端口锁定 + /api 代理到 8000
├── .env.example                # VITE_API_BASE_URL 说明
└── src/
    ├── main.js                 # createApp + 全局 errorHandler
    ├── App.vue                 # 应用外壳：品牌栏 + 四模块导航 + viewMap
    ├── assets/
    │   └── main.css            # 设计变量与通用样式（卡片/按钮/表单/表格/提示条…）
    ├── api/
    │   ├── client.js           # axios 实例、错误归一化、5MB 校验工具
    │   └── face.js             # 5 个接口封装 + 响应归一化（bbox / similarity）
    ├── components/
    │   ├── AppIcon.vue         # 内联 SVG 图标集（替代 emoji，统一尺寸与颜色）
    │   └── ResultTable.vue     # 识别结果表（两个识别模块共用）
    └── views/
        ├── UploadRecognize.vue # ① 图片上传识别
        ├── CameraRecognize.vue # ② 摄像头 Base64 帧识别
        ├── RegisterFace.vue    # ③ 人脸录入
        └── FeatureLibrary.vue  # ④ 特征库查看 / 删除
```

---

## 4. 接口映射

所有请求集中在 `src/api/face.js`，组件不直接写 URL。

| 前端函数 | 方法 | 后端路径 | 请求格式 | 返回（前端归一化后） |
| --- | --- | --- | --- | --- |
| `recognizeUpload(file, threshold)` | POST | `/api/recognize/upload` | multipart：`file` + Form `threshold` | `{ facesDetected, results }` |
| `recognizeFrame(base64, threshold)` | POST | `/api/recognize/frame` | JSON `{ image_base64 }` + query `threshold` | `{ facesDetected, results }` |
| `registerFace(file, name)` | POST | `/api/register` | multipart：`file` + Form `name` | `{ recordId, name }` |
| `listFeatures()` | GET | `/api/features` | — | `{ count, items: [{ id, name }] }` |
| `deleteFeature(name)` | DELETE | `/api/features/{name}` | 路径参数（已 `encodeURIComponent`） | `{ deleted, name }` |

### 后端返回值的两处不一致，已在前端抹平

1. **`bbox` 形态不同**
   - `/api/recognize/upload` → `{ "x":216, "y":206, "w":211, "h":211 }`
   - `/api/recognize/frame` → `[216, 206, 211, 211]`

   `normalizeBbox()` 统一转成 `{ x, y, w, h }`，并过滤零面积 / 非数字的非法框。

2. **`similarity` / `name` 可为 `null`**
   表示「检测到人脸但特征库里没比中」。注意 **不能** 用 `Number.isFinite(Number(v))` 判断，
   因为 `Number(null) === 0` 会把 `null` 误当合法的 `0`；`toNullableNumber()` 专门处理这个坑。

### 错误提示

`src/api/client.js` 的响应拦截器把后端 `{ "detail": "中文提示" }`（含 422 的数组形式）
统一转成 `Error(message)`，组件里 `catch (e) { errorMsg = e.message }` 即可，
无需自己解析 axios 错误结构。已覆盖：超时、连不上后端、404、413、5xx、422 数组。

---

## 5. 5MB 上传上限

后端 `router/api.py` **没有**限制请求体大小，因此 5MB 由前端把关，全部集中在
`src/api/client.js` 的 `MAX_UPLOAD_SIZE = 5 * 1024 * 1024`（= 5,242,880 字节），组件内不写魔数。

| 场景 | 校验函数 | 触发时机 |
| --- | --- | --- |
| 图片识别 / 人脸录入 | `validateImageFile(file)` | 选中或拖入文件的瞬间 + 提交前各一次 |
| 摄像头帧 | `validateBase64Frame(base64)` | 每帧抓取后、发请求前 |

细节：

- **边界是「含」**：恰好 5MB（5,242,880 字节）放行，5MB + 1 字节拦截。
- **格式**：jpg / png / bmp / webp。`file.type` 为空时（部分系统从剪贴板拖入）用后缀名兜底。
- **摄像头没有 `File` 对象**，用 `estimateBase64Bytes()` 按 Base64 长度反推真实字节数
  （每 4 字符 3 字节，扣除末尾 `=` 填充），截图质量滑块 0.5~0.95 用于控制单帧体积。
- **界面可视化**：两个识别模块都画了「当前体积 / 5MB」进度条，≥80% 变黄、满格变红，
  让限制在报错之前就可见。
- 超限时提示里会带上实际体积，例如：`图片体积 8.20 MB 超过上限 5MB，请压缩后再上传`。

---

## 6. 功能模块

### ① 图片识别（`UploadRecognize.vue`）

点击或拖拽选择图片 → 前端校验 → 本地预览 → 调 `/api/recognize/upload` → 在预览图上叠加人脸框 → 表格列出结果。

- 人脸框按**原图像素坐标**换算成百分比定位（依赖 `naturalWidth/naturalHeight`），
  预览图被容器缩放时框依然贴脸；人脸贴顶时标注自动翻到框内，避免被裁切。
- 阈值滑块 0.3~0.95，默认 0.6（与后端一致），可一键恢复默认。
- `<input type=file>` 选完立即清空 `value`，保证连续选择同一文件仍能触发 `change`。
- 预览用 `URL.createObjectURL`，换图与卸载时 `revokeObjectURL`，避免大图反复选择造成内存增长。

### ② 摄像头识别（`CameraRecognize.vue`）

`getUserMedia` 取流 → `<video>` 预览 → 离屏 canvas `drawImage` → `toDataURL('image/jpeg', q)` → 调 `/api/recognize/frame`。

- 支持「拍照并识别」单次模式与「连续识别」模式（间隔 1.2s）。
- 连续识别用**递归 `setTimeout`** 而非 `setInterval`：后者不管上一次请求是否结束都会到点触发，
  后端慢时会堆积请求；`busy` 单飞锁进一步保证同一时刻只有一个请求在飞。
- 资源释放：`MediaStreamTrack.stop()`、清定时器、断开 `video.srcObject`、释放 canvas，
  离开标签页（组件销毁）时全部执行，否则摄像头指示灯会一直亮。
- `getUserMedia` 失败按 `NotAllowedError` / `NotFoundError` / `NotReadableError` 分类给出中文指引。
- 刻意**不做** CSS 镜像（`scaleX(-1)`）：镜像只翻转画面，而 bbox 是原始坐标，会导致框与脸左右错位。
- 连续任务中单帧超 5MB 会自动停止循环，避免每 1.2 秒重复报同一个错。

### ③ 人脸录入（`RegisterFace.vue`）

姓名 + 人脸图片 → `/api/register`。

- 后端**按姓名判重**：同名再提交返回 409，界面会提示「需先在特征库删除旧记录」。
- 后端**只录入面积最大的那张脸**，界面与须知都引导使用单人正脸照。
- 检测不到人脸 → 后端 422，`detail` 文案原样展示。
- 成功后清空表单便于连续录入，并展示记录 ID；可一键跳转「特征库」。

### ④ 特征库（`FeatureLibrary.vue`）

`/api/features` 列表 + `/api/features/{name}` 删除。

- 删除采用**行内二次确认**（`删除 → 确认删除 / 取消`），不用 `window.confirm`。
- 删除成功后**重新拉取全量列表**（以服务端为准），不做本地 `splice`：
  后端按姓名批量删，`deleted` 是条数，以服务端数据为准才能保证界面与 SQLite 一致。
- 空库与「筛选无结果」是两种不同空态；支持按姓名筛选。

---

## 7. 界面与交互设计

### 7.1 设计令牌

颜色、圆角、阴影、动效时长全部收敛在 `src/assets/main.css` 的 `:root` 里，改主题只动一处：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--brand` | `#4f46e5` | 主色（主按钮、选中态、滑块、图标强调） |
| `--ink` / `--ink-soft` / `--muted` / `--faint` | 四级灰阶 | 正文 / 次要文字 / 说明 / 占位，只用这四档 |
| `--ok` `--warn` `--err` | 绿 / 琥珀 / 红 | 只用于识别结果与提示，不做装饰 |
| `--r-lg` `--r-md` `--r-sm` | 14 / 10 / 8px | 卡片 / 控件 / 小元素，只有三档圆角 |

配色上刻意去掉了大面积紫粉渐变，改为近乎中性的浅灰蓝底 + 两团极淡光晕，
把注意力留给内容本身；卡片用极轻投影 + 淡描边分层，而不是重阴影。

### 7.1.1 版式与留白

| 项目 | 取值 | 说明 |
| --- | --- | --- |
| 内容区宽度 | `max-width: 1520px` | 1440px 屏幕下内容铺满，两侧只剩 `clamp(18px, 2.4vw, 40px)` 的内边距 |
| 左右内边距 | `clamp(18px, 2.4vw, 40px)` | 跟随视口缩放，小屏不贴边、大屏不放纵 |
| 正文 | `15px` | 基准字号，比常规后台的 13~14px 大一档 |
| 卡片标题 | `16px` / 600 | 与正文 15px 拉开一档，层级清晰 |
| 页面标题 | `22px` | 顶部只保留标题，不放技术栈等实现说明 |
| 双栏 | `align-items: stretch` | 两列等高；结果卡用 `card-fill` 让空态在剩余高度里垂直居中，避免"矮卡 + 大块空白" |

顶部不再出现"Vue3 + Vite 前端 / FastAPI 接口 / 5MB 上限"这类说明，页面底部也不放
后端实现说明——这些信息属于文档，不该占据界面视觉重心。

### 7.2 图标

`components/AppIcon.vue` 内置一组 24×24、线性描边、`stroke="currentColor"` 的图标：

- 颜色继承父级 `color`，所以在卡片标题里自动变主色、在危险按钮里自动变红；
- 尺寸由 `size` 控制，视觉重量一致，不再出现 emoji 大小参差、各系统字形不同的情况；
- 不引入图标库，不增加依赖与打包体积。

渲染用 `v-html` 输出**本文件内写死的常量标记**（不来自接口或用户输入）。

### 7.3 模块导航与 URL hash

标签与地址栏 hash 双向同步：`#upload`、`#camera`、`#register`、`#features`。

- 刷新页面、分享链接都能停在同一模块；
- 内部切换用 `history.replaceState` 写入，**不往历史里堆记录**（点后退不会逐个倒着切模块）；
- 手动改地址栏或浏览器前进后退时由 `hashchange` 监听同步界面。

### 7.4 响应式断点

| 断点 | 变化 |
| --- | --- |
| `> 920px` | 左右双栏（操作区 / 结果区） |
| `≤ 920px` | 双栏堆叠为单列 |
| `≤ 720px` | 顶部能力标签换到标题下方 |
| `≤ 640px` | 页面左右留白收紧；标签栏等分宽度、收紧字号 |
| `≤ 460px` | 隐藏标签栏装饰性图标，把宽度让给"摄像头识别"这类 5 字标签，避免省略号截断 |

表格在窄屏下由 `.table-wrap` 提供横向滚动，不会把卡片撑破。
实测 390 / 430 / 1440 宽度下 `documentElement.scrollWidth` 均等于视口宽度，无页面级横向溢出。

### 7.5 可访问性

- 全局 `:focus-visible` 焦点环，键盘导航可见、鼠标点击不刺眼；
- 拖拽上传区支持 `Tab` 聚焦与 `Enter` / `Space` 触发；
- 图标统一 `aria-hidden="true"`，语义由文字承担；纯图标按钮补 `aria-label`；
- 加载/错误/成功提示分别带 `role="status"` / `role="alert"`；
- `prefers-reduced-motion: reduce` 时关闭动效。

---

## 8. 构建与部署

```bash
cd frontend
npm run build      # 产物在 frontend/dist
npm run preview    # 本地预览构建产物
```

开发模式通过 Vite 代理（`/api` → `127.0.0.1:8000`）实现同源，**不产生跨域**。

若把 `dist` 部署到与后端不同的域名/端口，需要两步：

1. `frontend/.env.local` 里设置后端地址：
   ```
   VITE_API_BASE_URL=http://127.0.0.1:8000
   ```
   此时请求变成真实跨域。
2. 把前端页面所在的源加入后端 `app.py` 的 CORS 白名单
   （当前只放行了 `http://localhost:5173`，**这项属于后端改动，需你自行确认**）。

---

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 页面提示「无法连接后端服务」 | 后端未启动，或端口不是 8000。检查 `uvicorn` 是否在跑 |
| 接口 500，日志有 `UnicodeEncodeError: 'gbk' codec` | 启动后端时未设置 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，见 2.3 |
| 接口 500，日志有 `sqlite3.ProgrammingError ... same thread` | 后端 `core/db_utils.py` 未包含线程安全修复，见第 10 节 |
| 摄像头打不开，提示权限被拒绝 | 点地址栏锁图标 → 摄像头 → 允许；或换 `http://localhost:5173` 访问（非 https 域名不算安全上下文） |
| 摄像头被占用 | 关闭微信 / 腾讯会议 / 相机等占用设备的程序 |
| 端口 5173 被占用，Vite 直接报错退出 | 这是刻意的：后端 CORS 白名单只放行 5173，`strictPort: true` 防止静默换端口导致跨域失败。请释放 5173 或同步修改后端 CORS |
| 识别一直「未识别」但人已在库里 | 阈值过高（调低到 0.5~0.6），或录入照片与现场光线/角度差异过大 |
| 检测不到人脸 | Haar 级联对侧脸、遮挡、强逆光、人脸过小敏感，换正脸清晰图 |
| 首次识别等很久 | FaceNet 权重加载 + CPU 推理，属正常；已把 axios 超时设为 180s |

---

## 10. 后端配套改动（重要）

按需求「后端不动」，本次**未改动任何业务逻辑**。但联调中发现两个阻塞性缺陷，处理如下：

### 10.1 已修复（1 行）：SQLite 跨线程使用

- **文件**：`core/db_utils.py`
- **改动**：`sqlite3.connect(db_path)` → `sqlite3.connect(db_path, check_same_thread=False)`
- **原因**：FastAPI 把同步路由函数交给 anyio 线程池执行，执行线程 ≠ 创建连接的线程，
  sqlite3 默认 `check_same_thread=True` 会直接抛异常。
- **影响范围**：不加这行修复，**全部 5 个接口都返回 500**，前端无法使用任何功能。
- **为何安全**：每个请求是「取连接 → 一次短事务」，不存在同一连接被并发写的场景。

### 10.2 无需改代码：GBK 控制台编码

`print` 里的 emoji 在 GBK 控制台会抛 `UnicodeEncodeError`（见 2.3），
通过启动时的环境变量规避，不改后端。

---

## 11. 已验证项

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 生产构建 | `vite build` | 通过（81 modules transformed） |
| 开发服务器 | `http://localhost:5173/` | 200，入口与 `/src/main.js` 正常 |
| 代理 | `http://localhost:5173/api/features` | 200，与直连后端一致 |
| 5MB 等纯逻辑 | esbuild 打包源码后在 Node 断言 44 项 | 全部通过（含 5MB 边界、Base64 体积、bbox 归一化、`similarity:null` 回归） |
| 五个接口端到端 | 真实后端 + 样例图片 | 全部通过：upload 命中 0.9653；frame 命中 similarity 1.0；register → 409 重名；delete → 404 不存在；特征库增删还原 |
| 界面渲染 | Chrome 无头截图 + CDP 驱动交互 | 四个模块的初始/已选文件/识别结果/删除确认/摄像头出画状态截图逐一核对 |
| hash 路由 | 直接访问 `#camera` / `#features` | 打开即落到对应模块 |
| 窄屏溢出 | CDP 量 `scrollWidth` 与元素 rect | 390 / 430 / 1440 宽度均无页面级横向溢出；4 个标签在 430px 下右边界 408px，无截断 |
