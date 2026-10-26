import * as THREE from 'three';
import { Ingredient } from '../types/ar';

export const INGREDIENTS: Ingredient[] = [
  {
    id: 'b5',
    number: '01',
    tag: 'Phục hồi',
    title: 'Vitamin B5',
    subtitle: 'Làm dịu da, phục hồi hàng rào bảo vệ',
    description:
      'D-Panthenol (Vitamin B5) nồng độ cao làm dịu tức thì làn da kích ứng, củng cố màng lipid tự nhiên và kích thích tái tạo tế bào biểu bì sâu từ bên trong.',
    highlight: '🛡️ Phục hồi màng bảo vệ da, làm dịu kích ứng và tăng cường sức đề kháng cho làn da khỏe khoắn.',
    side: 'left',
    localAnchor: new THREE.Vector3(-0.68, 1.05, 0.04),
    localElbow: new THREE.Vector3(-0.68, 1.05, 0.04),
    delay: 0.0,
    orbType: 'b5',
    iconSvg: '/svg/icon_vitamin_b_vector.svg',
  },
  {
    id: 'ha',
    number: '02',
    tag: 'Cấp ẩm sâu',
    title: 'Hyaluronic Acid',
    subtitle: 'Ngậm nước đa tầng, căng mọng 72H',
    description:
      'Phức hợp Hyaluronic Acid đa phân tử (Micro & Macro HA) thẩm thấu xuyên suốt các tầng biểu bì, khóa ẩm chuyên sâu và làm đầy các rãnh nhăn nông.',
    highlight: '💧 Ngậm nước sâu suốt 72 giờ, tăng 82% độ ẩm tức thì và duy trì độ đàn hồi mướt mịn.',
    side: 'left',
    localAnchor: new THREE.Vector3(-0.94, 0.46, 0.04),
    localElbow: new THREE.Vector3(-0.94, 0.46, 0.04),
    delay: 0.3,
    orbType: 'ha',
    iconSvg: '/svg/giot_nuoc_phan_tu.svg',
  },
  {
    id: 'c',
    number: '03',
    tag: 'Sáng da',
    title: 'Vitamin C',
    subtitle: 'Chống oxy hóa, mờ thâm nám rạng rỡ',
    description:
      'Dẫn xuất Vitamin C tinh khiết thế hệ mới chống gốc tự do mạnh mẽ, ức chế melanin hình thành và thúc đẩy tổng hợp collagen tự nhiên.',
    highlight: '🌸 Dưỡng sáng rạng ngời, làm mờ vết thâm mụn chỉ sau 14 ngày và ngăn ngừa lão hóa sớm.',
    side: 'right',
    localAnchor: new THREE.Vector3(0.74, 0.82, 0.04),
    localElbow: new THREE.Vector3(0.74, 0.82, 0.04),
    delay: 0.6,
    orbType: 'c',
    iconSvg: '/svg/orange-svgrepo-com.svg',
  },
];

export function getIngredientById(idOrKey: string): Ingredient | undefined {
  const norm = idOrKey.toLowerCase();
  return INGREDIENTS.find((ing) =>
    ing.id.toLowerCase() === norm ||
    ing.orbType?.toLowerCase() === norm ||
    norm.includes(ing.id.toLowerCase()) ||
    (norm.includes('b5') && ing.id === 'b5') ||
    (norm.includes('ha') && ing.id === 'ha') ||
    ((norm.includes('vc') || norm.includes('vitamin_c') || norm.includes('vitamin c') || norm.includes('orange')) && ing.id === 'c')
  );
}
