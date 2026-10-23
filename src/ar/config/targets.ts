// Image-target data loader — following flycam-logo pattern
// Converts imagePath to base64 DataURL for 0-latency offline tracking in 8th Wall engine.

export interface ImageTargetData {
  imagePath: string;
  metadata?: Record<string, unknown> | null;
  name: string;
  type: 'PLANAR' | 'CYLINDER' | 'CONICAL';
  properties: Record<string, unknown>;
  loadAutomatically?: boolean;
}

export async function loadImageTargetData(url = 'targets/serum.json'): Promise<ImageTargetData> {
  const res = await fetch(url);
  if (!res.ok) {
    // Fallback to assets path
    const fallbackRes = await fetch('assets/image-target/serum.json');
    if (!fallbackRes.ok) {
      throw new Error(`Image target JSON fetch failed: ${res.status} (${url})`);
    }
    return processTargetJson(await fallbackRes.json());
  }
  return processTargetJson(await res.json());
}

async function processTargetJson(json: ImageTargetData): Promise<ImageTargetData> {
  if (!json.name || !json.imagePath || !json.type) {
    throw new Error('Invalid image target JSON structure');
  }

  // Convert imagePath to base64 DataURL so 8th Wall loads it directly from memory
  if (!json.imagePath.startsWith('data:')) {
    try {
      const imgRes = await fetch(json.imagePath);
      if (imgRes.ok) {
        const blob = await imgRes.blob();
        json.imagePath = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (e) {
      console.warn('Failed to convert imagePath to data URL, keeping original:', e);
    }
  }

  return json;
}
