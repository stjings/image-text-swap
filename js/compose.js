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
   * 새 문구가 원래 폭을 넘칠 때 자간 압축 → 폰트 축소 → 폭 확장 → 경고 순으로
   * 적용하고, 첫 단계에서 해결되면 멈춘다.
   */
  function resolveOverflow(ctx, font, text, size, track, box, room) {
    const targetW = box.x1 - box.x0;
    let w = widthAt(ctx, font, text, size, track);
    if (w <= targetW) return {size, track, width: targetW, note: null};

    // 1단계 — 자간 추가 압축
    const tightened = track - size * TRACK_STEP;
    w = widthAt(ctx, font, text, size, tightened);
    if (w <= targetW) return {size, track: tightened, width: targetW, note: null};

    // 2단계 — 폰트 축소 (하한까지 이분 탐색)
    let lo = size * MIN_SCALE, hi = size, best = null;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const t = track * (mid / size) - mid * TRACK_STEP;
      if (widthAt(ctx, font, text, mid, t) <= targetW) { best = {size: mid, track: t}; lo = mid; }
      else hi = mid;
    }
    if (best) {
      const pct = Math.round(best.size / size * 100);
      return {...best, width: targetW, note: `문구가 길어 ${pct}%로 축소했습니다`};
    }

    // 3단계 — 폭 확장 (인접 블록·캔버스 경계까지)
    const shrunk = {size: size * MIN_SCALE, track: track * MIN_SCALE - size * MIN_SCALE * TRACK_STEP};
    const need = widthAt(ctx, font, text, shrunk.size, shrunk.track);
    if (need <= room) {
      return {...shrunk, width: need,
        note: `문구가 길어 ${Math.round(MIN_SCALE * 100)}%로 축소하고 폭을 넓혔습니다`};
    }

    // 4단계 — 경고 후 그대로
    return {...shrunk, width: need, note: '문구가 너무 길어 영역을 벗어납니다'};
  }

  /** 이 줄이 좌우로 얼마나 넓어질 수 있는지 — 다른 블록에 부딪히기 전까지. */
  function roomFor(box, allBlocks, selfId, W) {
    let left = 0, right = W;
    for (const b of allBlocks) {
      if (b.id === selfId) continue;
      const o = b.bbox;
      if (o.y1 <= box.y0 || o.y0 >= box.y1) continue;      // 세로로 안 겹치면 무관
      if (o.x1 <= box.x0) left = Math.max(left, o.x1);
      else if (o.x0 >= box.x1) right = Math.min(right, o.x0);
    }
    return right - left;
  }

  /* ---------- 정렬 추정 (7-6) ---------- */

  function guessAlign(lines) {
    if (lines.length < 2) return 'center';
    const xs = lines.map((l) => l.bbox.x0);
    const cs = lines.map((l) => (l.bbox.x0 + l.bbox.x1) / 2);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    return spread(xs) <= ALIGN_TOL && spread(xs) < spread(cs) ? 'left' : 'center';
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
      const align = guessAlign(b.lines);
      const texts = (b.editedText || '').split('\n');
      const boxes = b.lines.map((l) => l.bbox);
      const pitch = boxes.length > 1 ? boxes[1].y0 - boxes[0].y0
        : (boxes[0].y1 - boxes[0].y0) * 1.5;

      // 크기는 블록 안에서 하나로 통일한다. 줄마다 따로 맞추면 글자 구성에 따라
      // 잉크 높이가 달라 같은 크기였던 줄이 서로 다른 크기로 렌더된다.
      const srcLines = (b.originalText || '').split('\n');
      const sizes = boxes.map((bx, i) =>
        fitSize(ctx, font, srcLines[i] || texts[i] || '가', bx.y1 - bx.y0)).filter(Boolean);
      // 중앙값 중 큰 쪽을 택한다. 작은 크기를 고르면 글자가 상자를 못 채워
      // 자간으로 메우게 되고, 그 자간이 새 문구에 그대로 물려가 벌어져 보인다.
      const blockSize = sizes.length
        ? sizes.slice().sort((p2, q) => p2 - q)[Math.floor(sizes.length / 2)]
        : 16;

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

        const room = roomFor(box, blocks, b.id, W);
        const fit = resolveOverflow(ctx, font, text, size0, track0, box, room);
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
    const x = align === 'left'
      ? box.x0 + m.left
      : (box.x0 + box.x1) / 2 - m.w / 2 + m.left;
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
    util: {setFont, inkMetrics, fitSize, fitTracking, guessAlign, removalMask, ALPHA_T, INK_FAR},
  };
})();
