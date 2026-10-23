const fs = require('fs');
const path = require('path');
const sharp = require('/home/congthang/Downloads/Project/flower/node_modules/sharp');

async function main() {
  const srcImg = path.resolve(__dirname, '../../img_target.png');
  const outDir = path.resolve(__dirname, '../public/assets/image-target');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const img = sharp(srcImg);
  const meta = await img.metadata();
  console.log('Source metadata:', meta.width, 'x', meta.height, meta.format);

  // 8th Wall standard: 3:4 aspect ratio portrait
  const cropW = Math.round((meta.height * 3) / 4); // (1402 * 3) / 4 = 1052
  const cropH = meta.height; // 1402
  const cropLeft = Math.round((meta.width - cropW) / 2); // (1122 - 1052) / 2 = 35
  const cropTop = 0;

  console.log('Crop:', { left: cropLeft, top: cropTop, width: cropW, height: cropH });

  const cropped = img.clone().extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH });

  const lumHeight = 640;
  const lumWidth = Math.round((cropW * lumHeight) / cropH); // 480
  const thumbHeight = 350;
  const thumbWidth = Math.round((cropW * thumbHeight) / cropH); // 263

  await cropped.clone().resize(lumWidth, lumHeight).grayscale().jpeg({ quality: 90 }).toFile(path.join(outDir, 'serum_luminance.jpg'));
  await cropped.clone().resize(thumbWidth, thumbHeight).png().toFile(path.join(outDir, 'serum_thumbnail.png'));
  await cropped.clone().png().toFile(path.join(outDir, 'serum_cropped.png'));
  await img.clone().png().toFile(path.join(outDir, 'serum_original.png'));
  await img.clone().png().toFile(path.join(outDir, 'img_target.png'));

  const targetJson = {
    imagePath: 'assets/image-target/serum_luminance.jpg',
    metadata: {
      physicalWidthMeters: 0.2,
      sourceImage: 'assets/image-target/img_target.png',
    },
    name: 'serum-target',
    type: 'PLANAR',
    properties: {
      left: cropLeft,
      top: cropTop,
      width: cropW,
      height: cropH,
      isRotated: false,
      originalWidth: meta.width,
      originalHeight: meta.height,
    },
    resources: {
      originalImage: 'serum_original.png',
      croppedImage: 'serum_cropped.png',
      thumbnailImage: 'serum_thumbnail.png',
      luminanceImage: 'serum_luminance.jpg',
    },
    loadAutomatically: true,
  };

  fs.writeFileSync(path.join(outDir, 'serum-target.json'), JSON.stringify(targetJson, null, 2) + '\n');
  console.log('Successfully generated public/assets/image-target/serum-target.json and assets!');
}

main().catch(console.error);
