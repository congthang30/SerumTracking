import * as THREE from 'three';
import { Ingredient } from '../types/ar';

export const INGREDIENTS: Ingredient[] = [
  {
    id: 'vitamin_b5',
    number: '01',
    tag: 'Phục hồi',
    title: 'Vitamin B5',
    subtitle: 'Làm dịu da, phục hồi hàng rào da',
    description:
      'D-Panthenol (Vitamin B5) nồng độ cao làm dịu tức thì làn da kích ứng, tái tạo hàng rào bảo vệ tự nhiên của da.',
    highlight: '🛡️ Phục hồi màng bảo vệ da, làm dịu kích ứng và tăng cường sức đề kháng.',
    side: 'left',
    localAnchor: new THREE.Vector3(-0.240, 0.68, 0.05),
    localElbow: new THREE.Vector3(-0.38, 1.04, 0.055),
    delay: 0.0,
    orbType: 'b5',
    iconSvg: 'svg/icon_vitamin_b_vector.svg',
  },
  {
    id: 'hyaluronic_acid',
    number: '02',
    tag: 'Cấp ẩm sâu',
    title: 'Hyaluronic Acid',
    subtitle: 'Cấp ẩm sâu, giữ da mềm mịn',
    description:
      'Phức hợp Hyaluronic Acid đa phân tử thẩm thấu vào từng tầng biểu bì, ngậm nước gấp 1000 lần trọng lượng và giữ ẩm suốt 72 giờ.',
    highlight: '💧 Ngậm nước sâu 72H, làm căng mọng làn da và giảm nếp nhăn khô ráp.',
    side: 'left',
    localAnchor: new THREE.Vector3(-0.240, 0.38, 0.05),
    localElbow: new THREE.Vector3(-0.38, 0.13, 0.055),
    delay: 0.3,
    orbType: 'ha',
    iconSvg: 'svg/giot_nuoc_phan_tu.svg',
  },
  {
    id: 'vitamin_c',
    number: '03',
    tag: 'Sáng da',
    title: 'Vitamin C',
    subtitle: 'Làm sáng da, mờ thâm',
    description:
      'Dẫn xuất Vitamin C thế hệ mới giúp làm sáng đều màu da, mờ thâm nám và chống oxy hóa mạnh mẽ trước ánh nắng và ô nhiễm.',
    highlight: '🌸 Dưỡng sáng rạng rỡ, chống gốc tự do và kích thích sản sinh collagen.',
    side: 'right',
    localAnchor: new THREE.Vector3(0.240, 0.52, 0.05),
    localElbow: new THREE.Vector3(0.38, 0.59, 0.055),
    delay: 0.6,
    orbType: 'c',
    iconSvg: 'svg/orange-svgrepo-com.svg',
  },
];
