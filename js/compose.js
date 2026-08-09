/* compose.js — 글자 제거 · 렌더 · 합성 · 오버플로
 * PLAN.md 7-5, 7-6, 7-8
 *
 * 유형 A(투명 배경)는 알파를 0으로, 유형 B(단색 배경)는 배경을 복원해 지운다.
 * 그 외 경로(색 추출·피팅·자간·오버플로·렌더)는 두 유형이 전부 공유한다.
 *
 * 수정하지 않은 블록은 손대지 않는다. 전 블록을 재렌더하면 사용자가 건드리지도
 * 않은 문구까지 폰트 근사 오차로 열화된다(7-6).
 */
'use strict';

const Compose = (() => {

  const ALPHA_T = 20;
  const DILATE = 2;         // 제거 마스크 팽창 (7-5). 안티에일리어싱 잔상 방지
  const FIT_ITERS = 4;      // 폰트 크기 피팅 반복 (7-6)
  const TRACK_STEP = 0.05;  // 오버플로 1단계: 자간 추가 압축 (폰트 크기 대비)
  const MIN_SCALE = 0.7;    // 오버플로 2단계: 폰트 축소 하한
  const ALIGN_TOL = 4;      // 정렬 추정 허용 오차(px)
  const TRACK_MAX = 0.15;   // 자간 상한 (폰트 크기 대비)
  const INK_FAR = 96;       // 유형 B 잉크 판정: 배경색과의 채널 절대차 합
  const ANCHOR_MAX = 60;    // 배경 보간 시 좌우로 찾아볼 최대 거리(px)
  const BG_NEAR = 72;       // 배경 앵커로 인정할 대표색과의 최대 색거리
  const NEIGHBOR = 60;      // 한 줄 블록의 정렬 판단: 왼쪽 이웃으로 볼 최대 간격(px)

  /* ---------- 7-5 글자 제거 ---------- */

  /** 블록 안에서 글자 픽셀을 찾아 DILATE 만큼 부풀린 제거 마스크를 만든다.
   *  안티에일리어싱 잔상이 남지 않도록 부풀리는 것이 핵심이다. */
  function removalMask(d, W, H, block) {
    const {x0, y0, x1, y1} = block.bbox;
    const bg = block.bgColor;
    const m = new Uint8Array(W * H);
    const isInk = (i) => block.tier === 'A'
      ? d[i + 3] > ALPHA_T
      : d[i + 3] > 200 && Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1])
        + Math.abs(d[i + 2] - bg[2]) > INK_FAR;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!isInk((y * W + x) * 4)) continue;
        for (let dy = -DILATE; dy <= DILATE; dy++) {
          for (let dx = -DILATE; dx <= DILATE; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H) m[ny * W + nx] = 1;
          }
        }
      }
    }
    return m;
  }

  /** 유형 A — 알파를 0으로. 배경 복원이 필요 없다. */
  function eraseTransparent(d, W, mask) {
    for (let i = 0; i < mask.length; i++) if (mask[i]) d[i * 4 + 3] = 0;
  }

  /**
   * 유형 B — 배경을 복원해 덮는다.
   *
   * 계획서는 "대표색 하나로 채우기"였지만, 실측상 단색 배경도 위치에 따라 RGB가
   * 10 남짓 변한다(파란 정보 박스). 한 색으로 칠하면 그 자리가 띠처럼 보인다.
   * 대신 **줄 단위로 좌우 배경을 찾아 선형 보간**한다. 배경이 균일하면 결과가
   * 대표색 채우기와 같아지고, 변하면 그 변화를 따라간다.
   */
  function erasePaint(d, W, H, mask, block) {
    const {x0, y0, x1, y1} = block.bbox;
    const bg = block.bgColor || [255, 255, 255];
    const px = (x, y) => (y * W + x) * 4;

    // 좌우로 배경 픽셀을 찾는다. 못 찾으면 대표색으로 물러선다.
    //
    // '마스크 밖'이라는 조건만으로는 부족하다. 바로 옆 블록의 글자(파란 라벨의 ':')가
    // 마스크 밖에 있으니 그걸 배경으로 집어 들고, 그 어두운 색에서 오른쪽 배경까지
    // 선형 보간해 번지는 줄을 그린다. 대표색에 가까운 픽셀만 앵커로 인정한다.
    const anchor = (y, from, dir) => {
      for (let k = 1; k <= ANCHOR_MAX; k++) {
        const x = from + dir * k;
        if (x < 0 || x >= W) break;
        if (mask[y * W + x]) continue;
        const i = px(x, y);
        if (d[i + 3] <= 200) continue;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > BG_NEAR) continue;
        return [d[i], d[i + 1], d[i + 2]];
      }
      return null;
    };

    const pad = DILATE;
    for (let y = Math.max(0, y0 - pad); y < Math.min(H, y1 + pad); y++) {
      let x = Math.max(0, x0 - pad);
      const end = Math.min(W, x1 + pad);
      while (x < end) {
        if (!mask[y * W + x]) { x++; continue; }
        let run = x;
        while (run < end && mask[y * W + run]) run++;
        const L = anchor(y, x, -1) || bg;
        const R = anchor(y, run - 1, 1) || L;
        for (let k = x; k < run; k++) {
          const t = run - x > 1 ? (k - x) / (run - x - 1) : 0;
          const i = px(k, y);
          d[i]     = Math.round(L[0] + (R[0] - L[0]) * t);
          d[i + 1] = Math.round(L[1] + (R[1] - L[1]) * t);
          d[i + 2] = Math.round(L[2] + (R[2] - L[2]) * t);
          d[i + 3] = 255;
        }
        x = run;
      }
    }
  }

  function eraseBlock(d, W, H, block) {
    const mask = removalMask(d, W, H, block);
    if (block.tier === 'A') eraseTransparent(d, W, mask);
    else erasePaint(d, W, H, mask, block);
  }

  /* ---------- 7-6 측정 · 피팅 ---------- */

  const setFont = (ctx, font, size, track) => {
    ctx.font = `${font.weight} ${size}px "${font.family}"`;
    ctx.letterSpacing = `${track}px`;
  };

  function inkMetrics(ctx, text) {
    const m = ctx.measureText(text);
    return {
      w: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
      h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
      left: m.actualBoundingBoxLeft,
      asc: m.actualBoundingBoxAscent,
    };
  }

  /** 잉크 높이가 목표에 맞을 때까지 크기를 수렴시킨다. 공식으로는 안 맞는다(7-6). */
  function fitSize(ctx, font, text, targetH) {
    let size = targetH * 1.2;
    for (let i = 0; i < FIT_ITERS; i++) {
      setFont(ctx, font, size, 0);
      const h = inkMetrics(ctx, text).h;
      if (!h) break;
      size *= targetH / h;
    }
    return size;
  }

  /** 목표 폭에 맞는 자간. 글자수로 나누지 않고 두 점의 기울기로 역산한다(7-6).
   *
   * 값은 폰트 크기의 ±15%로 자른다. 판별된 폰트가 원본보다 좁으면 폭을 채우려고
   * 자간이 크게 잡히는데, 그 값을 짧아진 새 문구에 그대로 물려주면 글자가
   * 눈에 띄게 벌어진다. 폰트 불일치가 자간으로 증폭되는 것을 막는다. */
  function fitTracking(ctx, font, text, size, targetW) {
    setFont(ctx, font, size, 0);
    const w0 = inkMetrics(ctx, text).w;
    setFont(ctx, font, size, 10);
    const w10 = inkMetrics(ctx, text).w;
    const k = (w10 - w0) / 10;
    const raw = k ? (targetW - w0) / k : 0;
    const cap = size * TRACK_MAX;
    return Math.max(-cap, Math.min(cap, raw));
  }

  const widthAt = (ctx, font, text, size, track) => {
    setFont(ctx, font, size, track);
    return inkMetrics(ctx, text).w;
  };

  /* ---------- 7-8 오버플로 ---------- */

  /**
   * 목표 폭에 정확히 맞는 자간. fitTracking 과 같은 기울기 역산인데 상한을 안 건다.
   * 압축은 상한이 아니라 TRACK_STEP 으로 따로 제한한다.
   */
  function trackFor(ctx, font, text, size, targetW) {
    setFont(ctx, font, size, 0);
    const w0 = inkMetrics(ctx, text).w;
    setFont(ctx, font, size, 10);
    const k = (inkMetrics(ctx, text).w - w0) / 10;
    return k ? (targetW - w0) / k : 0;
  }

  /**
   * 새 문구가 넘칠 때의 처리 (v1.7 재작성).
   *
   * 예전 순서는 **자간 압축 → 폰트 축소 → 폭 확장** 이었다. 둘 다 틀렸다.
   *
   * 1. **압축이 먼저였다.** 블록 상자는 '원문 잉크가 차지한 크기'일 뿐 레이아웃
   *    상자가 아니다. 옆이 비어 있으면 그냥 넘어가면 된다 — 디자이너가 손으로
   *    고쳐도 그렇게 한다. 실측: `합격`→`불합격` 은 57px 넘쳤는데 오른쪽에
   *    1221px 이 비어 있었다. 그런데도 자간을 조이고 폰트를 줄여, 낱말 사이가
   *    사라지고 획이 얇아졌다.
   * 2. **압축량이 넘친 양과 무관했다.** 1px 이 넘치든 100px 이 넘치든 자간을
   *    폰트 크기의 5% 씩 깎았다. 실측: `50`→`60` 은 **2px(0.1%)** 넘쳤는데
   *    자간이 글자마다 3.9px 씩, 줄 전체로 83px 좁아졌다.
   *
   * 지금은 넘어갈 자리가 있으면 아무것도 건드리지 않고, 좁혀야 할 때는 **필요한
   * 만큼만** 좁힌다.
   */
  function resolveOverflow(ctx, font, text, size, track, box, avail) {
    const targetW = box.x1 - box.x0;
    // 상자보다 좁게 몰아넣지는 않는다. avail 이 상자보다 작게 나오면 무시한다.
    const limit = Math.max(targetW, avail);
    const w = widthAt(ctx, font, text, size, track);
    const grew = (over) => over > targetW * 0.02
      ? '문구가 길어져 원래 영역보다 넓어졌습니다' : null;

    // 0단계 — 들어가면 그대로. 원본 굵기·자간을 지키는 것이 가장 원본에 가깝다.
    if (w <= limit) return {size, track, width: w, note: grew(w - targetW)};

    // 1단계 — 필요한 만큼만 자간 압축 (상한은 폰트 크기의 TRACK_STEP)
    const floor = track - size * TRACK_STEP;
    const need = trackFor(ctx, font, text, size, limit);
    if (need >= floor) {
      return {size, track: need, width: limit, note: grew(limit - targetW)};
    }

    // 2단계 — 폰트 축소 (하한까지 이분 탐색)
    let lo = size * MIN_SCALE, hi = size, best = null;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const t = Math.max(trackFor(ctx, font, text, mid, limit),
                         track * (mid / size) - mid * TRACK_STEP);
      if (widthAt(ctx, font, text, mid, t) <= limit) { best = {size: mid, track: t}; lo = mid; }
      else hi = mid;
    }
    if (best) {
      return {...best, width: limit,
        note: `문구가 길어 글자를 ${Math.round(best.size / size * 100)}% 로 줄였습니다`};
    }

    // 3단계 — 더는 못 줄인다. 그대로 두고 알린다.
    const shrunk = {size: size * MIN_SCALE, track: floor * MIN_SCALE};
    return {...shrunk, width: widthAt(ctx, font, text, shrunk.size, shrunk.track),
            note: '문구가 너무 길어 옆 영역을 침범합니다'};
  }

  /** 이 줄의 좌우 경계 — 다른 블록에 부딪히기 전까지. */
  function roomFor(box, allBlocks, selfId, W) {
    let left = 0, right = W;
    for (const b of allBlocks) {
      if (b.id === selfId) continue;
      const o = b.bbox;
      if (o.y1 <= box.y0 || o.y0 >= box.y1) continue;      // 세로로 안 겹치면 무관
      if (o.x1 <= box.x0) left = Math.max(left, o.x1);
      else if (o.x0 >= box.x1) right = Math.min(right, o.x0);
    }
    return {left, right};
  }

  /**
   * 유형 B — 글자가 올라앉은 단색 바탕이 좌우로 어디까지 이어지는지.
   *
   * `roomFor` 는 **다른 글자 블록**만 본다. 그림은 모른다. 검은 원 배지의
   * `5명` 을 `10명` 으로 바꿀 때 옆에 글자가 없으니 "948px 비었다"고 판단하는데,
   * 실제로 글자가 놓일 수 있는 곳은 **원 안쪽 72px** 뿐이다. 더 길게 쓰면
   * 원 밖 사진 위로 글자가 삐져나간다.
   *
   * 블록 세로 중앙 줄을 좌우로 훑어 배경색이 이어지는 데까지를 경계로 잡는다.
   */
  function bgExtent(d, W, H, block) {
    const bg = block.bgColor;
    if (block.tier !== 'B' || !bg) return null;
    const y = Math.min(H - 1, Math.max(0, Math.round((block.bbox.y0 + block.bbox.y1) / 2)));
    const near = (x) => {
      const i = (y * W + x) * 4;
      return d[i + 3] > 200
        && Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < BG_NEAR;
    };
    let left = block.bbox.x0, right = block.bbox.x1;
    while (left > 0 && near(left - 1)) left--;
    while (right < W && near(right)) right++;
    return {left, right};
  }

  /**
   * 정렬 기준으로 실제 쓸 수 있는 폭.
   *
   * 왼쪽 정렬은 오른쪽으로만 자라고, 가운데 정렬은 양쪽으로 자란다 — 가운데는
   * 좁은 쪽이 한계다. 이걸 구분하지 않고 좌우 경계 사이 거리를 그대로 쓰면
   * 가운데 정렬 글자가 한쪽 이웃을 밟는다.
   */
  function usableWidth(box, align, bounds) {
    const {left, right} = bounds;
    if (align === 'left') return Math.max(0, right - box.x0);
    if (align === 'right') return Math.max(0, box.x1 - left);
    const cx = (box.x0 + box.x1) / 2;
    return Math.max(0, 2 * Math.min(cx - left, right - cx));
  }

  /* ---------- 정렬 추정 (7-6, v1.5 재작성) ---------- */

  /**
   * 블록의 정렬 기준을 추정한다.
   *
   * 예전에는 한 줄짜리 블록을 무조건 `center` 로 봤는데, 그게 편집 후 글자가
   * 옆으로 밀리는 원인이었다. 가운데 정렬은 문구 길이가 바뀌면 **차이의 절반만큼
   * 양옆으로 흔든다.** 실측: `~8/31(월)까지` → `~9/3(월)까지` 한 글자가 줄자
   * 시작 x 가 3.1px 오른쪽으로 갔다. 왼쪽 정렬이면 0px 이다.
   *
   * 한 줄에는 정렬을 알아낼 근거가 없다. 근거가 없을 때 흔들리지 않는 쪽을
   * 고르는 것이 맞다 — 왼쪽이다. `center` 는 증거가 있을 때만 준다.
   */
  function guessAlign(block, allBlocks, imageW) {
    const lines = block.lines || [];
    if (!lines.length) return 'left';

    if (lines.length >= 2) {
      const spread = (a) => Math.max(...a) - Math.min(...a);
      const sx = spread(lines.map((l) => l.bbox.x0));
      const sr = spread(lines.map((l) => l.bbox.x1));
      const sc = spread(lines.map((l) => (l.bbox.x0 + l.bbox.x1) / 2));
      if (sx <= ALIGN_TOL && sx <= sc && sx <= sr) return 'left';
      if (sr <= ALIGN_TOL && sr < sc && sr < sx) return 'right';
      return sc < sx && sc < sr ? 'center' : 'left';
    }

    // 왼쪽에 같은 줄의 다른 블록이 바짝 붙어 있으면 그 뒤에 이어지는 값이다.
    // `이벤트 기간 :` 다음의 `~8/31(월)까지` 같은 경우로, 왼쪽 끝이 고정이어야 한다.
    const box = block.bbox;
    if (allBlocks) {
      for (const o of allBlocks) {
        if (o.id === block.id || !o.bbox) continue;
        if (o.bbox.y1 <= box.y0 || o.bbox.y0 >= box.y1) continue;
        if (o.bbox.x1 <= box.x0 && box.x0 - o.bbox.x1 <= NEIGHBOR) return 'left';
      }
    }
    // 이미지 한가운데 놓인 한 줄은 가운데 정렬로 본다. 이건 증거가 있는 경우다.
    if (imageW) {
      const c = (box.x0 + box.x1) / 2;
      if (Math.abs(c - imageW / 2) <= Math.max(6, imageW * 0.02)) return 'center';
    }
    return 'left';
  }

  /** 블록에 확정해 둔 정렬을 쓰고, 없으면 그 자리에서 추정한다. */
  const alignOf = (block) => block.align || guessAlign(block);

  /* ---------- 블록 레이아웃 (합성·판별 공용) ---------- */

  /**
   * 한 블록의 타이포 값을 정한다. **합성과 판별 표시가 같은 값을 써야 한다.**
   * 따로 계산하면 "판별 화면에서 본 수치"와 "실제로 찍히는 글자"가 갈린다.
   */
  function layout(ctx, block, font, texts) {
    const boxes = block.lines.map((l) => l.bbox);
    const srcLines = (block.originalText || '').split('\n');
    const sizes = boxes.map((bx, i) =>
      fitSize(ctx, font, srcLines[i] || (texts && texts[i]) || '가', bx.y1 - bx.y0)).filter(Boolean);
    // 중앙값 중 큰 쪽. 작은 크기를 고르면 글자가 상자를 못 채워 자간으로 메우게 되고,
    // 그 자간이 새 문구에 그대로 물려가 벌어져 보인다.
    const size = sizes.length
      ? sizes.slice().sort((p, q) => p - q)[Math.floor(sizes.length / 2)]
      : 16;
    const pitch = boxes.length > 1 ? boxes[1].y0 - boxes[0].y0
      : (boxes[0].y1 - boxes[0].y0) * 1.5;
    return {boxes, srcLines, size, pitch, align: alignOf(block)};
  }

  /** 정렬 기준에 맞춰 잉크 왼쪽 끝이 놓일 x. */
  function inkX(align, box, m) {
    if (align === 'left') return box.x0;
    if (align === 'right') return box.x1 - m.w;
    return (box.x0 + box.x1) / 2 - m.w / 2;
  }

  /* ---------- 진입점 ---------- */

  /**
   * @param img   원본 ImageData
   * @param blocks 전체 블록 (충돌 검사에 쓴다)
   * @param pickFont (block) => {family, weight}  블록마다 다른 폰트를 쓸 수 있다
   * @returns {canvas, notes[]}  notes 는 사용자에게 보여줄 조치 사유
   */
  async function compose(img, blocks, pickFont) {
    await document.fonts.ready;

    const W = img.width, H = img.height;
    const out = new ImageData(new Uint8ClampedArray(img.data), W, H);
    const targets = blocks.filter((b) => b.dirty && !b.locked);
    const notes = [];

    // 유형 B 인데 배경색을 못 구한 블록은 지울 방법이 없다.
    const doable = targets.filter((b) => b.tier === 'A' || b.bgColor);
    for (const b of targets) {
      if (!doable.includes(b)) {
        notes.push({id: b.id, level: 'skip', text: '배경색을 찾지 못해 교체할 수 없습니다'});
      }
    }

    for (const b of doable) eraseBlock(out.data, W, H, b);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    ctx.putImageData(out, 0, 0);

    // 쓸 폰트를 먼저 전부 로드한다. 로드 전에 그리면 조용히 폴백 폰트로 찍힌다.
    const fonts = new Map();
    for (const b of doable) {
      const f = pickFont(b);
      fonts.set(b.id, f);
      await document.fonts.load(`${f.weight} 100px "${f.family}"`, '가힣0Aa');
    }

    for (const b of doable) {
      const font = fonts.get(b.id);
      const texts = (b.editedText || '').split('\n');
      // 크기는 블록 안에서 하나로 통일한다. 줄마다 따로 맞추면 글자 구성에 따라
      // 잉크 높이가 달라 같은 크기였던 줄이 서로 다른 크기로 렌더된다.
      const {boxes, srcLines, size: blockSize, pitch, align} = layout(ctx, b, font, texts);

      for (let i = 0; i < texts.length; i++) {
        const text = texts[i].trim();
        if (!text) continue;
        // 줄 수가 늘면 마지막 줄 아래로 같은 간격만큼 이어 붙인다.
        const base = boxes[Math.min(i, boxes.length - 1)];
        const shift = i < boxes.length ? 0 : (i - boxes.length + 1) * pitch;
        const box = {x0: base.x0, y0: base.y0 + shift, x1: base.x1, y1: base.y1 + shift};

        // 자간은 '원문' 기준으로 잡고 새 문구가 물려받는다(7-6).
        const src = srcLines[Math.min(i, boxes.length - 1)] || text;
        const size0 = blockSize;
        const track0 = fitTracking(ctx, font, src, size0, box.x1 - box.x0);

        // 이웃 글자 경계와 바탕이 이어지는 경계 중 좁은 쪽을 쓴다.
        const nb = roomFor(box, blocks, b.id, W);
        const bgb = bgExtent(img.data, W, H, b);
        const bounds = bgb
          ? {left: Math.max(nb.left, bgb.left), right: Math.min(nb.right, bgb.right)}
          : nb;
        const avail = usableWidth(box, align, bounds);
        const fit = resolveOverflow(ctx, font, text, size0, track0, box, avail);
        if (fit.note) notes.push({id: b.id, level: 'warn', text: fit.note});

        drawLine(ctx, font, text, box, fit, align, b);
      }
    }
    return {canvas, notes};
  }

  function drawLine(ctx, font, text, box, fit, align, block) {
    setFont(ctx, font, fit.size, fit.track);
    const m = inkMetrics(ctx, text);
    const cy = (box.y0 + box.y1) / 2;
    const x = inkX(align, box, m) + m.left;
    const y = cy - m.h / 2 + m.asc;

    const g = ctx.createLinearGradient(0, cy - m.h / 2, 0, cy + m.h / 2);
    g.addColorStop(0, `rgb(${block.colorTop.join(',')})`);
    g.addColorStop(1, `rgb(${block.colorBottom.join(',')})`);
    ctx.fillStyle = g;
    // 유형 A는 원본이 반투명 글자면 그대로 물려받는다. 유형 B는 이미 불투명
    // 배경 위에 그리므로 알파를 낮추면 배경이 비쳐 색이 흐려진다.
    ctx.globalAlpha = block.tier === 'A' ? (block.opacity ?? 1) : 1;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  // 폰트 판별(fontmatch.js)이 같은 피팅·렌더 경로를 써야 한다. 판별과 합성이
  // 다른 방식으로 글자를 놓으면 "판별할 때 닮았던 폰트"가 합성에서 달라진다.
  return {
    compose,
    util: {setFont, inkMetrics, fitSize, fitTracking, guessAlign, alignOf, layout, inkX, roomFor, bgExtent, usableWidth, resolveOverflow,
           removalMask, ALPHA_T, INK_FAR, TRACK_MAX},
  };
})();
