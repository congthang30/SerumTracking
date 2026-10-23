# HYDRATING SERUM — WEBAR (REACT + VITE + THREE.JS + 8TH WALL)

Ứng dụng WebAR Image Tracking cao cấp cho sản phẩm **HYDRATING SERUM**, được xây dựng bằng **React**, **Vite**, **TypeScript**, **Three.js** và **8th Wall Open-Source XR Engine**.

---

## 1. Cấu Trúc Thư Mục Dự Án

```
serum/
├── public/
│   ├── assets/
│   │   ├── models/
│   │   │   ├── serum_ex.glb          # 3D Model chính thức (39.9 MB)
│   │   │   └── serum4.glb            # Symlink/Alias hỗ trợ
│   │   ├── textures/                 # Nhãn và textures trích xuất
│   │   └── image-target/
│   │       ├── img_target.png        # Poster gốc (1122x1402)
│   │       ├── serum-target.json     # Metadata 8th Wall Image Target
│   │       ├── serum_luminance.jpg   # Ảnh grayscale độ tương phản cao
│   │       ├── serum_thumbnail.png   # Thumbnail
│   │       └── serum_cropped.png     # Ảnh crop chuẩn tỷ lệ
│   └── external/
│       └── xr/
│           ├── xr.js                 # 8th Wall Core Engine (1 MB)
│           ├── xr-slam.js            # SLAM Engine
│           └── resources/            # WebAssembly & Shaders
├── src/
│   ├── components/
│   │   ├── ARCanvas.tsx              # WebGL rendering canvas
│   │   ├── ARLoadingScreen.tsx       # Màn hình loading & cấp quyền camera
│   │   ├── ARScanOverlay.tsx         # Khung ngắm quét laser & hướng dẫn
│   │   └── IngredientOverlay.tsx     # Lớp SVG vẽ đường line & Modal chi tiết
│   ├── ar/
│   │   ├── engine/
│   │   │   └── EightWallManager.ts   # Quản lý vòng đời 8th Wall XR pipeline
│   │   ├── tracking/
│   │   │   └── ImageTrackingController.ts # Bộ lọc làm mượt pose (slerp/lerp)
│   │   ├── scene/
│   │   │   └── SerumScene.ts         # Khởi tạo Three.js, studio lighting rig
│   │   ├── models/
│   │   │   └── SerumModelLoader.ts   # Nạp GLB, khúc xạ nước vật lý, 3D anchors
│   │   ├── animation/
│   │   │   └── ProductStoryTimeline.ts # Timeline cinematic của sản phẩm
│   │   └── callouts/
│   │       └── CalloutProjection.ts  # Chiếu tọa độ 3D -> Màn hình 60fps
│   ├── hooks/
│   │   └── useAREngine.ts            # Custom hook tích hợp UI và WebAR
│   ├── data/
│   │   └── ingredients.ts            # Dữ liệu 2 thành phần hoạt chất
│   ├── styles/
│   │   └── ar.css                    # Luxury Skincare styling
│   ├── types/
│   │   └── ar.ts                     # Type definitions
│   ├── App.tsx                       # Root UI Component
│   └── main.tsx                      # React Entry point
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 2. Hướng Dẫn Cài Đặt & Chạy Ứng Dụng

### Cài đặt dependencies:
```bash
cd serum
npm install
```

### Chạy môi trường Development:
```bash
npm run dev
```
Trình duyệt mở tại: `http://localhost:5173/`

### Build Production:
```bash
npm run build
```
Thư mục bundle nằm tại `dist/`.

### Xem trước bản Build (Preview):
```bash
npm run preview
```

---

## 3. Cách Thử Nghiệm Trên Điện Thoại

1. **Yêu cầu kết nối**:
   - Máy tính và điện thoại kết nối **cùng một mạng Wi-Fi**.
   - Chạy `npm run dev -- --host`. Vite sẽ hiển thị địa chỉ LAN, ví dụ: `http://192.168.1.15:5173/`.
2. **Yêu cầu quyền Camera (HTTPS)**:
   - Trình duyệt di động (Safari iOS / Chrome Android) yêu cầu kết nối an toàn (HTTPS hoặc localhost) để mở camera.
   - Bạn có thể dùng công cụ tunnel nhanh như **ngrok**:
     ```bash
     ngrok http 5173
     ```
   - Mở đường dẫn `https://xxxx.ngrok-free.app` trên điện thoại.
3. **Quét Poster**:
   - Khi mở trang trên điện thoại, ứng dụng tự khởi động AR. Chọn **Cho phép (Allow)** khi trình duyệt hỏi quyền camera.
   - Hướng camera vào poster [img_target.png](public/assets/image-target/img_target.png) (có thể hiển thị poster trên màn hình máy tính hoặc in ra giấy).
   - Chai serum 3D sẽ xuất hiện, nổi bồng bềnh và lần lượt hiển thị 2 đường Callout thành phần.

---

## 4. Xem Trước 3D Trên Máy Tính

- Trên máy tính, trang tự mở preview 3D có thể xoay và quan sát.
- Có thể thêm `?sim=1` vào URL để mở preview thủ công trên điện thoại.
- Poster [img_target.png](public/assets/image-target/img_target.png) không bật mặc định trong preview.

---

## 5. Tùy Biến Nâng Cao

### A. Thay đổi Image Target:
1. Đặt ảnh target mới vào `public/assets/image-target/your_target.png`.
2. Cập nhật `src/ar/engine/EightWallManager.ts` đường dẫn JSON hoặc dùng file metadata mới.

### B. Chỉnh kích thước và vị trí Model:
Trong file `src/ar/models/SerumModelLoader.ts`:
- Vị trí offset theo trục Z trên poster: `modelScene.position.set(0, 0, -0.20);`
- Tỷ lệ hiển thị sản phẩm được điều khiển bởi `baseScale` trong `src/ar/animation/ProductStoryTimeline.ts`.

### C. Thêm hoặc đổi thành phần Callout:
Mở `src/data/ingredients.ts` và chỉnh sửa hoặc thêm mới vào mảng `INGREDIENTS`:
```typescript
{
  id: 'vitamin_c',
  number: '03',
  tag: 'Chống oxy hóa',
  title: 'VITAMIN C',
  subtitle: 'Làm sáng đều màu da',
  description: 'Dẫn xuất Vitamin C ổn định cao...',
  highlight: '🌟 Hỗ trợ mờ thâm và sáng da tự nhiên.',
  side: 'right',
  localAnchor: new THREE.Vector3(0.13, 0.05, 0.09),
}
```

---

## 6. Báo Cáo Kiểm Thử

| Hạng mục | Trạng thái | Ghi chú |
| :--- | :---: | :--- |
| **Cài đặt & Build Vite** | **ĐẠT** | `tsc --noEmit` & `npm run build` chạy thành công không cảnh báo lỗi |
| **Model 3D & Vật liệu** | **ĐẠT** | Giữ nguyên 100% dung dịch serum hồng, nắp rose gold, hoa nở, cánh hoa rơi và nước khúc xạ |
| **Vị trí căn chỉnh poster** | **ĐẠT** | Đã nâng trục dọc để bệ đá và thân chai khớp chính xác với hình vẽ trên [img_target.png](file:///home/congthang/Downloads/MODEL/serum/public/assets/image-target/img_target.png) |
| **Chế độ Thử nghiệm (Simulation)** | **ĐẠT** | Xác minh render tự động qua Chrome Headless với kết quả hoàn hảo |
| **Kiểm thử Camera thật trên Mobile** | *Cần chạy trên thiết bị* | Yêu cầu mở qua HTTPS/ngrok trên điện thoại để cấp quyền camera vật lý |
