"""
人脸检测模块（Haar 级联分类器）
职责：定位人脸位置，返回人脸框坐标 [(x, y, w, h), ...]
"""

import os
import shutil
import cv2
import numpy as np


class FaceDetection:
    def __init__(self, model_name='haarcascade_frontalface_alt2.xml'):
        if not hasattr(cv2, 'CascadeClassifier'):
            raise RuntimeError(
                "当前 opencv-python 版本不支持 Haar 级联检测（5.x 已移除）。\n"
                "请降级安装 4.x 版本：pip install \"opencv-python>=4.8,<5\""
            )

        model_path = self._resolve_model_path(model_name)
        self.face_engine = cv2.CascadeClassifier(model_path)

        if self.face_engine.empty():
            raise ValueError(f"无法加载人脸检测模型：{model_path}")

    @staticmethod
    def _resolve_model_path(model_name):
        """
        解决 Windows 中文路径下 OpenCV 无法打开模型文件的问题。
        策略：路径含非 ASCII 字符时，把模型复制到纯英文目录再加载。
        """
        src_path = os.path.join(cv2.data.haarcascades, model_name)

        # 1. 文件必须存在（不存在说明 OpenCV 安装不完整，或你还没下载）
        if not os.path.isfile(src_path):
            raise FileNotFoundError(
                f"模型文件不存在：{src_path}\n"
                f"请下载 {model_name} 并放到该目录，或修改 model_name 指向你存放模型的路径。\n"
                f"下载地址：https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/{model_name}"
            )

        # 2. 路径是纯 ASCII，直接返回
        if src_path.isascii():
            return src_path

        # 3. 路径含中文 → 复制到纯英文目录
        safe_dir = r"C:\opencv_models"
        os.makedirs(safe_dir, exist_ok=True)
        safe_path = os.path.join(safe_dir, model_name)

        if not os.path.exists(safe_path) or os.path.getsize(safe_path) == 0:
            shutil.copy2(src_path, safe_path)  # Python 层支持中文，复制没问题
            print(f"检测到中文路径，模型已复制到：{safe_path}")

        return safe_path
        
    
    @staticmethod
    def preprocess(image):
        """
        图像预处理：消除光照、噪声干扰，降低算法计算压力
        """
        #1. 色彩空间转换：BGR -> 灰度图（Haar 检测只需灰度信息）
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        #2. 光照均衡化：直方图均衡化，解决明暗差异过大问题
        #gray = cv2.equalizeHist(gray)
        #3. 图像降噪：高斯模糊去除画面噪点
        #gray = cv2.GaussianBlur(gray, (3, 3), 0)
        return gray
    

    def detect_faces(self, image, scale_factor=1.1, min_neighbors=5, min_size=(50, 50)):
        """
        检测图像中的人脸（核心方法，图片和摄像头帧都走这里）
        :param image: BGR 图像
        :return: 人脸坐标列表 [(x, y, w, h), ...]
        """
        if not isinstance(image, np.ndarray):
            raise TypeError("图像数据类型错误，应为numpy.ndarray")

        gray = self.preprocess(image)
        faces = self.face_engine.detectMultiScale(
            gray,
            scaleFactor=scale_factor,
            minNeighbors=min_neighbors,
            minSize=min_size
        )
        # 边界校验：过滤越界或过小的框，防止后续切片报错
        height, width = image.shape[:2]
        valid_faces = []
        for (x, y, w, h) in faces:
            if w < 10 or h < 10:
                continue  # 框太小，忽略
            x2, y2 = x + w, y + h
            if x < 0 or y < 0 or x2 > width or y2 > height:
                continue  # 越界，忽略
            valid_faces.append((x, y, w, h))
        return valid_faces
    

    @staticmethod
    def crop_face_rois(image, faces):
        """
        根据人脸框坐标，从原图切割提取每一张人脸子图像
        :return: [(roi图像, 坐标), ...]
        """
        rois = []
        for (x, y, w, h) in faces:
            rois.append((image[y:y + h, x:x + w], (x, y, w, h)))
        return rois