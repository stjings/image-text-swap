/* ocr.js — Tesseract.js 래퍼 (전처리 · 인식)
 * PLAN.md 7-2, 9-1
 *
 * 자산은 전부 vendor/ 에서 자체 호스팅한다. 외부 CDN(jsdelivr·unpkg·
 * tessdata.projectnaptha)이 막힌 환경이 실제로 존재하므로 CDN에 의존하지 않는다.
 */
'use strict';

const OCR = (() => {

  const BASE = './vendor/tesseract/';
  const TARGET_H = 64;    // OCR에 유리한 줄 높이. 이보다 작으면 확대한다
  const MIN_OPACITY = 0.2;  // 알파 정규화 하한 (0 나눗셈 방지)
  const MAX_SCALE = 4;
  const PAD = 12;         // 흰 여백. 글자가 가장자리에 붙으면 인식률이 떨어진다
  const FAR_MAX = 180;    // 유형 B 색거리 → 명암 매핑 기준

  let worker = null;
  let booting = null;

  /** 워커 기동. traineddata 로딩이 길어 진행률을 콜백으로 흘린다. */
  function init(onProgress) {
    if (booting) return booting;
    booting = (async () => {
      worker = await Tesseract.createWorker(['kor', 'eng'], 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE,
        langPath: BASE + 'lang',
        gzip: false,                      // tessdata_fast 원본은 압축본이 아니다
        logger: (m) => onProgress && onProgress(m),
      });
      return worker;
    })();
    return booting;
  }

  /* ---------- 7-2 전처리 ----------
   * 배경 유형과 무관하게 '흰 바탕에 검은 글자'로 정규화한다.
   * 투명 PNG를 그대로 넣으면 투명 픽셀이 검정으로 읽혀 흰 글자가 사라진다.
   */
  function preprocess(img, block) {
    const {x0, y0, x1, y1} = block.bbox;
    const bw = x1 - x0, bh = y1 - y0;
    const d = img.data, W = img.width;

    const gray = new ImageData(bw, bh);
    const g = gray.data;
    const bg = block.bgColor;
    const op = Math.max(MIN_OPACITY, block.opacity || 1);

    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = ((y0 + y) * W + (x0 + x)) * 4;
        const o = (y * bw + x) * 4;
        let v;
        if (block.tier === 'A') {
          // 알파를 블록의 대표 불투명도로 정규화한다. 반투명 글자(예: α 최대 153)를
          // 그대로 쓰면 회색으로 찍혀 대비가 부족해 인식률이 크게 떨어진다.
          v = 255 - Math.min(255, d[i + 3] / op);
        } else if (bg) {
          const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
          v = 255 - Math.round(255 * Math.min(1, dist / FAR_MAX));
        } else {
          v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        }
        g[o] = g[o + 1] = g[o + 2] = v;
        g[o + 3] = 255;
      }
    }

    // 작은 글자는 확대해야 인식된다. 샘플 B 각주는 11px 라 확대 없이는 거의 실패한다.
    const lineH = block.lines.length
      ? block.lines.reduce((s, l) => s + (l.bbox.y1 - l.bbox.y0), 0) / block.lines.length
      : bh;
    const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_H / lineH));

    const src = document.createElement('canvas');
    src.width = bw; src.height = bh;
    src.getContext('2d').putImageData(gray, 0, 0);

    const out = document.createElement('canvas');
    out.width = Math.round(bw * scale) + PAD * 2;
    out.height = Math.round(bh * scale) + PAD * 2;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, PAD, PAD, Math.round(bw * scale), Math.round(bh * scale));
    return out;
  }

  /** 블록 하나를 인식한다. 실패하면 빈 문자열을 돌려주고 예외를 던지지 않는다. */
  async function recognizeBlock(img, block) {
    const canvas = preprocess(img, block);
    await worker.setParameters({
      tessedit_pageseg_mode: '6',   // 균일 블록. 한 줄짜리에도 7보다 안정적이다
      preserve_interword_spaces: '1',
    });
    try {
      const {data} = await worker.recognize(canvas);
      const text = (data.text || '').replace(/\s*\n\s*/g, '\n').trim();
      return {text, confidence: data.confidence ?? 0};
    } catch (e) {
      return {text: '', confidence: 0, error: String(e)};
    }
  }

  async function terminate() {
    if (worker) { await worker.terminate(); worker = null; booting = null; }
  }

  // 검증 도구가 PSM 을 바꿔 가며 비교할 수 있게 원시 인식도 노출한다.
  const recognizeWith = async (canvas, psm) => {
    await worker.setParameters({tessedit_pageseg_mode: psm, preserve_interword_spaces: '1'});
    const {data} = await worker.recognize(canvas);
    return {text: (data.text || '').replace(/\s*\n\s*/g, '\n').trim(),
            confidence: data.confidence ?? 0};
  };

  return {init, preprocess, recognizeBlock, recognizeWith, terminate};
})();
