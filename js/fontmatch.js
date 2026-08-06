/* fontmatch.js — 폰트 후보 렌더 · 실루엣 비교 · 자동판별
 * PLAN.md 7-7, 8-1
 *
 * 판별은 블록 단위로 한다. 한 이미지 안에서도 줄마다 폰트가 다르다(M0 확인).
 * 이미지 전체에 폰트 하나를 적용하면 얇은 줄이 굵은 폰트로 뭉개진다.
 */
'use strict';

const FontMatch = (() => {

  /** 등록 후보군 (PLAN.md 8-1). 전부 SIL Open Font License 1.1. */
  const CANDIDATES = [
    {family: 'Noto Sans KR', weight: 400}, {family: 'Noto Sans KR', weight: 700},
    {family: 'Noto Sans KR', weight: 900},
    {family: 'Gothic A1', weight: 400}, {family: 'Gothic A1', weight: 700},
    {family: 'Gothic A1', weight: 900},
    {family: 'IBM Plex Sans KR', weight: 400}, {family: 'IBM Plex Sans KR', weight: 700},
    {family: 'Nanum Gothic', weight: 400}, {family: 'Nanum Gothic', weight: 700},
    {family: 'Nanum Gothic', weight: 800},
    {family: 'Black Han Sans', weight: 400},
    {family: 'Jua', weight: 400},
  ];

  const label = (f) => `${f.family} ${f.weight}`;
  const GAP_LOW = 0.04;   // 1위–2위 격차가 이보다 작으면 확신이 낮다고 본다

  let loaded = false;
  async function loadAll() {
    if (loaded) return;
    await document.fonts.ready;
    await Promise.all(CANDIDATES.map((f) =>
      document.fonts.load(`${f.weight} 100px "${f.family}"`, '가힣0Aa')));
    loaded = true;
  }

  /* ---------- 실루엣 ---------- */

  /** 블록 영역의 원본 글자 실루엣 (bbox 크기의 이진 마스크). */
  function sourceSilhouette(img, block) {
    const {x0, y0, x1, y1} = block.bbox;
    const w = x1 - x0, h = y1 - y0;
    const d = img.data, W = img.width;
    const bg = block.bgColor;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * W + (x0 + x)) * 4;
        const ink = block.tier === 'A'
          ? d[i + 3] > Compose.util.ALPHA_T
          : bg && d[i + 3] > 200 && Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1])
            + Math.abs(d[i + 2] - bg[2]) > Compose.util.INK_FAR;
        m[y * w + x] = ink ? 1 : 0;
      }
    }
    return m;
  }

  /**
   * 후보 폰트로 원문을 같은 자리에 렌더한 실루엣.
   *
   * 계획서 7-7은 "크롭 → 리스케일 → 무게중심 정렬" 정규화를 요구했지만,
   * 7-6의 피팅(크기·자간)이 이미 원본 상자에 맞춰 글자를 놓으므로 그 단계가
   * 그대로 정규화 역할을 한다. 따로 정규화하면 오히려 정보를 잃는다.
   */
  function renderSilhouette(ctx, w, h, block, font) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    const {setFont, inkMetrics, fitSize, fitTracking, guessAlign} = Compose.util;
    const align = guessAlign(block.lines);
    const srcLines = (block.originalText || '').split('\n');
    const ox = block.bbox.x0, oy = block.bbox.y0;

    const sizes = block.lines.map((l, i) =>
      fitSize(ctx, font, srcLines[i] || '가', l.bbox.y1 - l.bbox.y0)).filter(Boolean);
    if (!sizes.length) return null;
    const size = sizes.slice().sort((a, b) => a - b)[Math.floor(sizes.length / 2)];

    for (let i = 0; i < block.lines.length; i++) {
      const text = srcLines[i];
      if (!text) continue;
      const box = block.lines[i].bbox;
      const track = fitTracking(ctx, font, text, size, box.x1 - box.x0);
      setFont(ctx, font, size, track);
      const m = inkMetrics(ctx, text);
      const cy = (box.y0 + box.y1) / 2 - oy;
      const x = align === 'left' ? box.x0 - ox + m.left
        : (box.x0 + box.x1) / 2 - ox - m.w / 2 + m.left;
      ctx.fillText(text, x, cy - m.h / 2 + m.asc);
    }
    return true;
  }

  const iou = (a, b) => {
    let inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) {
      const p = a[i], q = b[i];
      if (p & q) inter++;
      if (p | q) uni++;
    }
    return uni ? inter / uni : 0;
  };

  /* ---------- 판별 ---------- */

  /**
   * 블록 하나의 폰트를 판별한다.
   * @returns {family, weight, score, gap, lowConfidence, ranking[]} | null
   */
  async function detectFor(img, block) {
    if (!block.originalText || !block.lines.length) return null;
    await loadAll();

    const {x0, y0, x1, y1} = block.bbox;
    const w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return null;

    const src = sourceSilhouette(img, block);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});

    const scores = [];
    for (const font of CANDIDATES) {
      if (!renderSilhouette(ctx, w, h, block, font)) continue;
      const d = ctx.getImageData(0, 0, w, h).data;
      const cand = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) cand[p] = d[i + 3] > Compose.util.ALPHA_T ? 1 : 0;
      scores.push({...font, score: iou(src, cand)});
    }
    if (!scores.length) return null;

    scores.sort((a, b) => b.score - a.score);
    const gap = scores.length > 1 ? scores[0].score - scores[1].score : 1;
    return {
      family: scores[0].family, weight: scores[0].weight,
      score: scores[0].score, gap, lowConfidence: gap < GAP_LOW,
      // 전체 순위를 돌려준다. UI 는 앞의 몇 개만 쓰지만, 검증 도구가 특정 폰트의
      // 점수를 찾아야 하므로 잘라서 주면 비교가 편향된다.
      ranking: scores.map((s) => ({font: label(s), score: s.score})),
    };
  }

  /** 여러 블록을 순차 판별한다. onStep 으로 진행 상황을 흘린다. */
  async function detectAll(img, blocks, onStep) {
    await loadAll();
    for (let i = 0; i < blocks.length; i++) {
      onStep && onStep(i, blocks.length);
      blocks[i].detectedFont = await detectFor(img, blocks[i]);
    }
  }

  return {CANDIDATES, detectFor, detectAll, loadAll, label, GAP_LOW};
})();
