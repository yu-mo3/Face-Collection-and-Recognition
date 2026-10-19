"""
核心 FastAPI 路由接口
包含：
接口一：图片上传识别（POST /api/recognize/upload）
接口二：Base64 帧识别（POST /api/recognize/frame）
接口三：人脸录入（POST /api/register）
接口四：查看特征库（GET /api/features）
接口五：删除特征库某个记录（DELETE /api/features/{name}）
"""
import io
import base64
import numpy as np
import cv2
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from pydantic import BaseModel

from face.face_detection import FaceDetection
from face.face_recognition import FaceRecognition
from core.db_utils import face_db

router = APIRouter()
face_detector = FaceDetection(model_name='haarcascade_frontalface_alt2.xml')


def _bytes_to_cv2(image_bytes: bytes):
    """字节流 → OpenCV BGR 图像"""
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "无法解析图像，请确认文件是有效的图片格式")
    return img




# 图片上传识别接口
@router.post("/recognize/upload")
def recognize_upload(
    file: UploadFile = File(...),
    threshold: float = Form(0.6),
):
    contents = file.file.read()
    image = _bytes_to_cv2(contents)

    faces = face_detector.detect_faces(image)
    if not faces:
        return {"faces_detected": 0, "results": []}

    results = []
    for roi, (x, y, w, h) in face_detector.crop_face_rois(image, faces):
        result = FaceRecognition.recognize_face(roi, threshold=threshold)
        results.append({
            "bbox": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
            "name": result["name"] if result else None,
            "similarity": round(result["similarity"], 4) if result else None,
        })

    return {"faces_detected": len(faces), "results": results}




# Base64 帧识别接口
class FrameRequest(BaseModel):
    image_base64: str

@router.post("/recognize/frame")
def recognize_frame(req: FrameRequest, threshold: float = 0.6):
    raw = req.image_base64
    # 兼容 data:image/jpeg;base64,xxxx 这种带前缀的格式
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        image_bytes = base64.b64decode(raw)
    except Exception:
        raise HTTPException(400, "Base64 解码失败")

    image = _bytes_to_cv2(image_bytes)
    faces = face_detector.detect_faces(image)

    results = []
    for roi, (x, y, w, h) in face_detector.crop_face_rois(image, faces):
        result = FaceRecognition.recognize_face(roi, threshold=threshold)
        results.append({
            "bbox": [int(x), int(y), int(w), int(h)],
            "name": result["name"] if result else None,
            "similarity": round(result["similarity"], 4) if result else None,
        })
    return {"faces_detected": len(faces), "results": results}




# 人脸录入接口
@router.post("/register")
def register_face(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    if not name.strip():
        raise HTTPException(400, "姓名不能为空")

    contents = file.file.read()
    image = _bytes_to_cv2(contents)

    faces = face_detector.detect_faces(image)
    if not faces:
        raise HTTPException(422, "未检测到人脸，请更换图片")

    # 只取第一张最大人脸，避免一张图多脸录入歧义
    faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
    roi, _ = face_detector.crop_face_rois(image, faces[:1])[0]

    feature = FaceRecognition.extract_feature(roi)
    if feature is None:
        raise HTTPException(500, "特征提取失败")

    record_id = face_db.save_feature(feature, name.strip())
    if record_id is None:
        raise HTTPException(409, f"「{name}」已存在特征记录，请先删除再重录")

    return {"record_id": record_id, "name": name.strip()}




# 特征库管理接口
# 查看特征库
@router.get("/features")
def list_features():
    features, info_list = face_db.get_all_features()
    if features is None:
        return {"count": 0, "items": []}
    return {"count": int(features.shape[0]), "items": info_list}

# 删除某一个特征记录
@router.delete("/features/{name}")
def delete_feature(name: str):
    deleted = face_db.delete_by_name(name)
    if deleted == 0:
        raise HTTPException(404, f"库中没有「{name}」的记录")
    return {"deleted": deleted, "name": name}