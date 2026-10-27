# Surface Tracking và Ground Grid Preview

8th Wall World Tracking duy trì một ground plane ngang ở `Y = 0` và có thể định nghĩa lại plane đó theo feature points đang thấy. XR8 không cung cấp hai plane sàn/bàn có ID và độ cao độc lập. [World Tracking Issues](https://8thwall.org/docs/troubleshooting/world-tracking-issues).

Trong ứng dụng, phép chiếu ray giữa màn hình vẫn dùng mốc sàn XR8 `Y = 0` cho reticle đặt model. Lưới Ground Grid Preview luôn được ẩn. Reticle chỉ xuất hiện khi World Tracking ở `NORMAL` ổn định khoảng 350 ms; khi tracking `LIMITED`, camera nhìn ngang/hướng lên, hoặc pose nhảy lớn thì nó tạm ẩn. Vị trí X/Z được làm mượt; độ cao không phụ thuộc khoảng cách camera. Không còn bộ chọn hay hiệu chỉnh Sàn/Bàn và HUD 6DoF.

Sau khi đặt, model vẫn thuộc world anchor. Ground Grid Preview không ghi vào transform của model hoặc gọi `XR8.recenter()`. Nếu XR8 tự định nghĩa lại world origin, ma trận trong scene vẫn có thể giữ nguyên nhưng vị trí cảm nhận ngoài đời có thể đổi. Cần kiểm tra trên điện thoại để xác nhận độ khớp vật lý.

Model sau khi đặt có chiều cao mục tiêu 30 cm, gấp 1,5 lần mức 20 cm trước đó. Kích thước trước khi đặt trong chế độ camera lock không đổi.

Kiểm tra mã: `npm run test:surface` và `npm run build`.
