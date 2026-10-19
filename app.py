"""
负责创建 FastAPI 实例、配置 CORS、挂载路由
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from router.api import router

app = FastAPI(
    title="人脸识别 API",
    swagger_ui_parameters={
        "swagger_js_url": "https://cdn.staticfile.org/swagger-ui/5.1.0/swagger-ui-bundle.js",
        "swagger_css_url": "https://cdn.staticfile.org/swagger-ui/5.1.0/swagger-ui.css",
    }
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vue3 Vite 默认端口
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")