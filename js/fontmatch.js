/* fontmatch.js — 폰트 후보 렌더 · 실루엣 비교 · 자동판별
 * PLAN.md 7-7, 8-1
 *
 * 판별은 블록 단위로 한다. 한 이미지 안에서도 줄마다 폰트가 다르다(M0 확인).
 * 이미지 전체에 폰트 하나를 적용하면 얇은 줄이 굵은 폰트로 뭉개진다.
 */
'use strict';

const FontMatch = (() => {

  /**
   * 자동판별 후보 — 디자인팀이 실제로 쓰는 세 패밀리로 한정한다.
   *
   * 후보를 넓히면 정답이 아닌 폰트가 IoU 만으로 이기는 일이 생긴다. 샘플 A
   * 헤드라인에서 Black Han Sans(58.6%)가 SUIT 900(47.5%)을 눌렀지만, 눈으로
   * 보면 숫자 '2027' 모양이 SUIT 쪽이 원본에 가깝다. IoU 는 겹친 잉크 면적을
   * 재므로 획이 굵은 폰트에 유리하고 글자 '모양' 차이는 덜 반영한다.
   * 실제로 쓰는 폰트만 후보에 두는 것이 이 편향을 피하는 가장 확실한 방법이다.
   */
  const CANDIDATES = [
    {family: 'SUIT', weight: 400}, {family: 'SUIT', weight: 500},
    {family: 'SUIT', weight: 600}, {family: 'SUIT', weight: 700},
    {family: 'SUIT', weight: 800}, {family: 'SUIT', weight: 900},
    {family: 'Pretendard', weight: 400}, {family: 'Pretendard', weight: 500},
    {family: 'Pretendard', weight: 600}, {family: 'Pretendard', weight: 700},
    {family: 'Pretendard', weight: 800}, {family: 'Pretendard', weight: 900},
    {family: 'Noto Sans KR', weight: 400}, {family: 'Noto Sans KR', weight: 700},
    {family: 'Noto Sans KR', weight: 900},
  ];

  /**
   * 자동판별에는 쓰지 않지만 '직접 선택'으로는 고를 수 있는 폰트.
   * 미리 받지 않고 고를 때 로드하므로 최초 전송량에 들어가지 않는다.
   */
  const EXTRA = [
    {family: 'Gothic A1', weight: 400}, {family: 'Gothic A1', weight: 700},
    {family: 'Gothic A1', weight: 900},
    {family: 'IBM Plex Sans KR', weight: 400}, {family: 'IBM Plex Sans KR', weight: 700},
    {family: 'Nanum Gothic', weight: 400}, {family: 'Nanum Gothic', weight: 700},
    {family: 'Nanum Gothic', weight: 800},
    {family: 'Black Han Sans', weight: 400},
    {family: 'Jua', weight: 400},
  ];

  const ALL = CANDIDATES.concat(EXTRA);

  const label = (f) => `${f.family} ${f.weight}`;
  const GAP_LOW = 0.04;   // 1위–2위 격차가 이보다 작으면 확신이 낮다고 본다
  const VOTE_MIN = 4;     // 패밀리 다수결에 필요한 최소 블록 수
  const ADJUST_MAX_DROP = 0.05;  // 다수결로 바꿀 때 감수할 최대 점수 하락

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
      ranking: scores.map((s) => ({font: label(s), family: s.family, weight: s.weight, score: s.score})),
    };
  }

  /**
   * 여러 블록을 순차 판별한다. onStep 으로 진행 상황을 흘린다.
   *
   * 판별이 끝나면 확신이 낮은 블록을 이미지의 지배적 패밀리로 맞춘다.
   * 짧고 작은 글자는 후보 점수가 고만고만해 같아 보이는 라벨 셋이 서로 다른
   * 폰트로 갈리는 일이 생긴다. 한 디자인이 여러 패밀리를 섞는 경우는 드무니,
   * 애매할 때는 그 이미지에서 가장 잘 맞은 패밀리를 따르는 편이 덜 튄다.
   * 확신이 있는 블록(1위-2위 격차가 큰)은 자기 판단을 유지한다.
   */
  async function detectAll(img, blocks, onStep) {
    await loadAll();
    for (let i = 0; i < blocks.length; i++) {
      onStep && onStep(i, blocks.length);
      blocks[i].detectedFont = await detectFor(img, blocks[i]);
    }

    const found = blocks.map((b) => b.detectedFont).filter(Boolean);
    if (found.length < VOTE_MIN) return;   // 근거가 얇으면 다수결을 적용하지 않는다

    // 블록마다 패밀리별 최고 점수를 모아, 합이 가장 높은 패밀리를 고른다.
    const fam = new Map();
    for (const f of found) {
      const best = new Map();
      for (const r of f.ranking) {
        if (!best.has(r.family) || best.get(r.family) < r.score) best.set(r.family, r.score);
      }
      for (const [k, v] of best) fam.set(k, (fam.get(k) || 0) + v);
    }
    let dominant = null, top = -1;
    for (const [k, v] of fam) if (v > top) { top = v; dominant = k; }
    if (!dominant) return;

    for (const b of blocks) {
      const f = b.detectedFont;
      if (!f || !f.lowConfidence || f.family === dominant) continue;
      const pick = f.ranking.find((r) => r.family === dominant);
      // 점수를 크게 깎으면서까지 맞추지는 않는다. 정말 다른 폰트일 수 있다.
      if (!pick || f.score - pick.score > ADJUST_MAX_DROP) continue;
      b.detectedFont = {...f, family: pick.family, weight: pick.weight,
                        score: pick.score, adjusted: true};
    }
  }

  return {CANDIDATES, EXTRA, ALL, detectFor, detectAll, loadAll, label, GAP_LOW};
})();
