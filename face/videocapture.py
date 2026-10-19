"""
打开摄像头
拍照并保存人脸图片
"""

import cv2
import numpy as np
import time


# 打开摄像头
cap = cv2.VideoCapture(0)

if not cap.isOpened():
        print('摄像头打开失败,请检查摄像头连接和权限')
        exit()


# 循环读取摄像头每一帧画面
while True:
    ret, frame = cap.read()
    if not ret:
        print('读取画面失败')
        break

    # 显示每一帧画面形成视频
    cv2.imshow('Camera', frame)

    # 摄像头画面刷新时间
    key = cv2.waitKey(1) & 0xFF
    
    # 按下s键，保存当前帧图片
    if key == ord('s'):
         # 以时间戳命名
         photo_path = './photo_' + time.strftime('%Y%m%d_%H%M%S') + '.jpg'
         success = cv2.imwrite(photo_path, frame)
         if success:
              print("照片保存成功：", photo_path)
    
    # 按下q键，退出循环
    elif key == ord('q'):
         break
    
# 释放摄像头资源，关闭窗口
cap.release()
cv2.destroyAllWindows()