/* detect.js — 배경 유형 판정 · 잉크 검출 · 블록 분리 · 색 추출
 * PLAN.md 7-1, 7-3, 7-4
 *
 * 두 갈래로 검출한다.
 *   1차: 알파 마스크 → 투명 배경 위의 글자 (유형 A)
 *   2차: 불투명 영역에서 단색 패치를 먼저 찾고, 그 안의 이물 픽셀을 글자로 (유형 B)
 * 사진·그라데이션 위의 글자(유형 C)는 이번 버전에서 검출 대상이 아니다.
 */
'use strict';

const Detect = (() => {

  const ALPHA_T = 20;      // 잉크/투명 임계 (7-3)
  const CLEAR_R = 0.15;    // 투명 배경 판정: bbox 내 α≤ALPHA_T 비율 (7-1)
  const SIGMA_T = 8;       // 단색 판정 표준편차 (7-1)
  const QUANT = 16;        // 색 양자화 단위
  const NEAR = 72;         // 배경색 근접 판정 (채널 절대차 합)
  const FAR = 96;          // 배경 대비 이물(글자) 판정
  const CORE_R = 0.65;     // 글자 코어 판정: 최대 색거리 대비 비율
  const RLSA_X = 26;       // 가로 런렝스 평활 하한 — 글자를 줄로 잇는다
  const RLSA_Y = 4;        // 세로 런렝스 평활 하한
  // 낱말 사이 간격은 글자 크기에 비례한다. 고정 픽셀값만 쓰면 큰 글자에서
  // 낱말이 안 이어져 한 줄이 여러 조각으로 갈린다(rlsaAuto).
  const RLSA_RATIO = 0.5;    // 글자 높이 대비 가로 평활 거리
  const RLSA_Y_RATIO = 0.08; // 글자 높이 대비 세로 평활 거리
  const MIN_H = 7, MAX_H = 170;   // 텍스트 줄 높이 허용 범위
  const MIN_W = 8;
  const PATCH_MIN = 1500;  // 단색 패치 최소 픽셀 수
  const SIG_SPLIT = 0.35;  // 배경 대비 색 방향이 이보다 벌어지면 같은 줄이라도 나눈다
  const MIN_SEG = 8;       // 색 분리 후 구간의 최소 폭(px)
  const ANCHOR_H = 0.45;   // 색 기준이 될 수 있는 조각의 최소 높이(줄 높이 대비)
  // 문단의 줄 간격은 줄 높이의 0.86배, 떨어진 라벨끼리는 1.14배로 측정됐다.
  // 그 사이인 1.0을 경계로 둔다.
  const LINE_GAP = 1.0;    // 같은 블록으로 묶을 최대 줄 간격(줄 높이 대비)
  // 한 블록으로 묶으면 합성이 크기를 하나로 통일한다. 크기가 다른 줄을 묶으면
  // 그 통일이 두 줄을 다 망친다. 실측: 진짜 여러 줄 블록의 줄 높이 비는
  // 최대 1.071(샘플 A·B 6블록). 크기가 다른 헤드라인 두 줄은 1.22 였다.
  const LINE_RATIO = 1.15; // 같은 블록으로 묶을 최대 줄 높이 비

  /* ---------- 마스크 유틸 ---------- */

  /** 가로/세로 방향으로 gap 이하의 빈틈을 메운다 (run length smoothing). */
  function rlsa(mask, W, H, gx, gy) {
    const out = Uint8Array.from(mask);
    for (let y = 0; y < H; y++) {           // 가로
      let last = -1;
      for (let x = 0; x < W; x++) {
        if (mask[y * W + x]) {
          if (last >= 0 && x - last <= gx) for (let k = last + 1; k < x; k++) out[y * W + k] = 1;
          last = x;
        }
      }
    }
    for (let x = 0; x < W; x++) {           // 세로
      let last = -1;
      for (let y = 0; y < H; y++) {
        if (mask[y * W + x]) {
          if (last >= 0 && y - last <= gy) for (let k = last + 1; k < y; k++) out[k * W + x] = 1;
          last = y;
        }
      }
    }
    return out;
  }

  /**
   * 글자 크기에 맞춘 거리로 다시 평활한다.
   *
   * `RLSA_X` 를 픽셀 상수로 두면 해상도가 큰 이미지에서 낱말이 안 이어진다.
   * 2280px 헤드라인(글자 높이 73px)에서 낱말 사이 배경이 26px 를 넘어
   * `지금 공단기로` / `넘어오면 전-직렬` / `50만원 할인!` 세 조각으로 갈렸다.
   * 낱말 사이는 글자 크기에 비례하는데 기준만 고정이었던 것이다.
   *
   * 1차 평활로 글자 높이를 먼저 재고, 그 높이에 비례한 거리로 한 번 더 평활한다.
   * **거리는 늘리기만 한다.** 줄이면 작은 글자 이미지의 기존 동작이 바뀐다.
   */
  function rlsaAuto(mask, W, H) {
    const first = rlsa(mask, W, H, RLSA_X, RLSA_Y);
    const hs = [];
    for (const r of components(first, W, H, 30)) {
      const b = tighten(mask, W, r);
      if (b && textLike(b)) hs.push(b.y1 - b.y0);
    }
    if (!hs.length) return first;
    hs.sort((a, b) => a - b);
    const med = hs[Math.floor(hs.length / 2)];
    const gx = Math.round(med * RLSA_RATIO);
    if (gx <= RLSA_X) return first;
    return rlsa(mask, W, H, gx, Math.max(RLSA_Y, Math.round(med * RLSA_Y_RATIO)));
  }

  /** 4-연결 컴포넌트. {x0,y0,x1,y1,count} 배열을 반환한다. */
  function components(mask, W, H, minCount = 1, collect = false) {
    const seen = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    const out = [];
    for (let s = 0; s < W * H; s++) {
      if (!mask[s] || seen[s]) continue;
      let sp = 0, count = 0;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      const pix = collect ? [] : null;
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const i = stack[--sp], x = i % W, y = (i / W) | 0;
        count++;
        if (pix) pix.push(i);
        if (x < x0) x0 = x; if (x + 1 > x1) x1 = x + 1;
        if (y < y0) y0 = y; if (y + 1 > y1) y1 = y + 1;
        if (x > 0     && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0     && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
        if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
      }
      if (count >= minCount) out.push({x0, y0, x1, y1, count, pixels: pix});
    }
    return out;
  }

  /** 평활된 영역 안에서 실제 잉크 픽셀만으로 다시 잰 타이트한 bbox (7-3). */
  function tighten(ink, W, r) {
    let x0 = r.x1, y0 = r.y1, x1 = r.x0, y1 = r.y0, n = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
      if (!ink[y * W + x]) continue;
      n++;
      if (x < x0) x0 = x; if (x + 1 > x1) x1 = x + 1;
      if (y < y0) y0 = y; if (y + 1 > y1) y1 = y + 1;
    }
    return n ? {x0, y0, x1, y1, count: n} : null;
  }

  const textLike = (b) => {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (h < MIN_H || h > MAX_H || w < MIN_W) return false;
    const fill = b.count / (w * h);
    return fill >= 0.03 && fill <= 0.92;
  };

  /* ---------- 7-1 배경 유형 판정 ---------- */

  function judgeTier(d, W, H, box, pad) {
    const b = {
      x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad),
      x1: Math.min(W, box.x1 + pad), y1: Math.min(H, box.y1 + pad),
    };
    let clear = 0, n = 0;
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
      n++; if (d[(y * W + x) * 4 + 3] <= ALPHA_T) clear++;
    }
    if (clear / n >= CLEAR_R) return {tier: 'A', clearRatio: clear / n};

    // 단색 판정 — 블록 안에서 배경이 글자보다 넓다는 가정
    const hist = new Map();
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] <= 200) continue;
      const k = ((d[i] / QUANT) | 0) * 4096 + ((d[i + 1] / QUANT) | 0) * 64 + ((d[i + 2] / QUANT) | 0);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    if (!hist.size) return {tier: 'C', clearRatio: clear / n};
    let bk = -1, bc = 0;
    for (const [k, c] of hist) if (c > bc) { bc = c; bk = k; }
    const cen = [((bk / 4096) | 0) * QUANT + 8, (((bk / 64) | 0) % 64) * QUANT + 8, (bk % 64) * QUANT + 8];

    const near = [];
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] <= 200) continue;
      if (Math.abs(d[i] - cen[0]) + Math.abs(d[i + 1] - cen[1]) + Math.abs(d[i + 2] - cen[2]) < NEAR)
        near.push([d[i], d[i + 1], d[i + 2]]);
    }
    if (near.length / n < 0.45) return {tier: 'C', clearRatio: clear / n};
    const ch = (j) => near.map((p) => p[j]);
    const sd = Math.max(...[0, 1, 2].map((j) => stdev(ch(j))));
    if (sd >= SIGMA_T) return {tier: 'C', clearRatio: clear / n};
    return {tier: 'B', clearRatio: clear / n, bgColor: [0, 1, 2].map((j) => med(ch(j)))};
  }

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] | 0; };
  const stdev = (a) => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };

  /* ---------- 7-4 색·불투명도 추출 ---------- */

  function extractColor(d, W, b, weightAt) {
    const band = (ya, yb) => {
      let r = 0, g = 0, bl = 0, wt = 0;
      for (let y = ya; y < yb; y++) for (let x = b.x0; x < b.x1; x++) {
        const i = (y * W + x) * 4;
        const k = weightAt(x, y);                  // 0~1 가중 (7-4)
        if (k <= 0) continue;
        r += d[i] * k; g += d[i + 1] * k; bl += d[i + 2] * k; wt += k;
      }
      return wt ? [Math.round(r / wt), Math.round(g / wt), Math.round(bl / wt)] : null;
    };
    const h = b.y1 - b.y0, q = Math.max(1, Math.round(h * 0.25));
    const top = band(b.y0, b.y0 + q), bottom = band(b.y1 - q, b.y1);
    const all = band(b.y0, b.y1) || [0, 0, 0];

    const as = [];
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++)
      if (weightAt(x, y) > 0) as.push(d[(y * W + x) * 4 + 3]);
    as.sort((p, q2) => p - q2);
    const opacity = as.length ? as[Math.floor(as.length * 0.95)] / 255 : 1;

    return {top: top || all, bottom: bottom || all, opacity};
  }

  /* ---------- 2차: 불투명 영역의 단색 패치 ---------- */

  function solidPatches(d, W, H) {
    const hist = new Map();
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      if (d[i + 3] <= 200) continue;
      const k = ((d[i] / QUANT) | 0) * 4096 + ((d[i + 1] / QUANT) | 0) * 64 + ((d[i + 2] / QUANT) | 0);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const patches = [];
    const cands = [...hist.entries()].filter(([, c]) => c >= PATCH_MIN)
      .sort((a, b) => b[1] - a[1]).slice(0, 8);

    for (const [k] of cands) {
      const cen = [((k / 4096) | 0) * QUANT + 8, (((k / 64) | 0) % 64) * QUANT + 8, (k % 64) * QUANT + 8];
      const m = new Uint8Array(W * H);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (d[i + 3] <= 200) continue;
        if (Math.abs(d[i] - cen[0]) + Math.abs(d[i + 1] - cen[1]) + Math.abs(d[i + 2] - cen[2]) < NEAR) m[p] = 1;
      }
      // 구멍(글자)을 메워 패치 전체 모양을 얻는다
      const filled = rlsa(m, W, H, 40, 40);
      for (const c of components(filled, W, H, PATCH_MIN, true)) {
        const area = (c.x1 - c.x0) * (c.y1 - c.y0);
        if (area < 2500 || c.count / area < 0.6) continue;   // 속이 찬 덩어리만
        patches.push({bbox: c, color: cen, pixels: c.pixels});
      }
    }
    return patches;
  }

  /* ---------- 7-3 한 줄 안의 색 분리 ----------
   * 한 줄에 색이 두 가지 섞여 있으면(파란 라벨 + 검은 값) 하나로 묶었을 때
   * 지배적인 색으로 통일돼 재현이 틀어진다. 글자 조각을 왼쪽부터 훑으며
   * 색이 바뀌는 지점에서 끊는다.
   */
  /**
   * 색을 '크기'가 아니라 '배경에서 벗어난 방향'으로 비교한다.
   *
   * 얇은 획은 전부 안티에일리어싱이라 같은 검정이어도 옅게 잡힌다. 절대 색으로
   * 비교하면 굵은 글자와 얇은 글자가 다른 색으로 갈려 단색 문장이 찢어진다.
   * 배경에서 뻗어 나간 방향(단위벡터)은 굵기와 무관하게 같으므로, 진짜로 색이
   * 다를 때만 벌어진다.
   */
  function colorSig(color, bg) {
    if (!bg) return color.map((v) => v / 255);
    const v = [color[0] - bg[0], color[1] - bg[1], color[2] - bg[2]];
    const n = Math.hypot(v[0], v[1], v[2]);
    return n < 12 ? null : v.map((q) => q / n);   // 배경과 사실상 같은 색은 기준이 못 된다
  }

  const sigDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  function splitByColor(d, W, ink, box, distAt, bg) {
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    if (w < MIN_SEG * 2) return [{bbox: box, sig: null}];

    const local = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      local[y * w + x] = ink[(box.y0 + y) * W + (box.x0 + x)];

    // 글자 조각별 대표색. 한글은 한 음절이 한두 조각으로 잡힌다.
    //
    // 코어 픽셀 임계값은 '조각마다' 따로 잡아야 한다. 줄 전체 기준으로 잡으면
    // 대비가 약한 색(연한 배경 위 파란 라벨)이 통째로 가중치 0이 되어
    // 아예 후보에서 사라지고, 그러면 색이 둘인 줄을 나눌 수가 없다.
    const parts = [];
    for (const c of components(local, w, h, 4)) {
      const px = [];
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) {
        if (!local[y * w + x]) continue;
        const gx = box.x0 + x, gy = box.y0 + y;
        px.push([gx, gy, distAt ? distAt(gx, gy) : d[(gy * W + gx) * 4 + 3]]);
      }
      if (!px.length) continue;
      const mx = px.reduce((m, q) => Math.max(m, q[2]), 0);
      const core = mx * CORE_R;
      let r = 0, g = 0, b = 0, wt = 0;
      for (const [gx, gy, v] of px) {
        if (v < core) continue;
        const i = (gy * W + gx) * 4;
        const k = distAt ? 1 : d[i + 3] / 255;
        r += d[i] * k; g += d[i + 1] * k; b += d[i + 2] * k; wt += k;
      }
      if (wt > 0) {
        // 쉼표·마침표처럼 키가 작은 조각은 획이 얇아 배경에 물든다. 그 색으로
        // 구간을 새로 열면 단색 문장이 잘게 찢어진다. 색 기준을 정할 자격은
        // 줄 높이의 절반 이상인 조각에만 준다.
        const color = [r / wt, g / wt, b / wt];
        const sig = colorSig(color, bg);
        const anchor = sig !== null && (c.y1 - c.y0) >= h * ANCHOR_H;
        parts.push({x0: c.x0, x1: c.x1, sig, wt, anchor});
      }
    }
    if (parts.length < 2) return [{bbox: box, sig: null}];
    parts.sort((a, b) => a.x0 - b.x0);

    // 자격 있는 조각만으로 구간을 세운다.
    const anchors = parts.filter((p) => p.anchor);
    if (!anchors.length) return [{bbox: box, sig: null}];
    const runs = [];
    for (const p of anchors) {
      const last = runs[runs.length - 1];
      if (last && sigDist(last.sig, p.sig) <= SIG_SPLIT) {
        last.x1 = Math.max(last.x1, p.x1);
        const t = p.wt / (last.wt + p.wt);
        last.sig = last.sig.map((v, i) => v + (p.sig[i] - v) * t);
        last.wt += p.wt;
      } else {
        runs.push({x0: p.x0, x1: p.x1, sig: p.sig.slice(), wt: p.wt});
      }
    }

    // 자격 없는 조각(쉼표·물결표처럼 키가 작은 것)은 '가로로 가장 가까운' 구간에
    // 붙인다. 무조건 앞 구간에 붙이면 '기간 : ~8/31' 의 물결표가 파란 라벨에
    // 딸려 들어가, 값을 고쳐도 물결표만 원본 자리에 남는다.
    for (const p of parts) {
      if (p.anchor) continue;
      let best = null, bd = Infinity;
      for (const r of runs) {
        const gap = p.x0 >= r.x1 ? p.x0 - r.x1 : (p.x1 <= r.x0 ? r.x0 - p.x1 : 0);
        if (gap < bd) { bd = gap; best = r; }
      }
      if (best) { best.x0 = Math.min(best.x0, p.x0); best.x1 = Math.max(best.x1, p.x1); }
    }
    runs.sort((a, b) => a.x0 - b.x0);

    // 작은 조각이 잘못 연 구간이 남을 수 있다. 방향이 가까운 이웃끼리 다시 합친다.
    for (let i = 0; i < runs.length - 1; i++) {
      if (sigDist(runs[i].sig, runs[i + 1].sig) > SIG_SPLIT) continue;
      runs[i].x1 = Math.max(runs[i].x1, runs[i + 1].x1);
      runs[i].wt += runs[i + 1].wt;
      runs.splice(i + 1, 1); i--;
    }
    if (runs.length < 2) return [{bbox: box, sig: runs[0] ? runs[0].sig : null}];

    // 너무 좁은 구간은 노이즈다. 색이 더 가까운 이웃에 흡수시킨다.
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].x1 - runs[i].x0 >= MIN_SEG || runs.length === 1) continue;
      const L = runs[i - 1], R = runs[i + 1];
      const host = !L ? R : !R ? L
        : (sigDist(L.sig, runs[i].sig) <= sigDist(R.sig, runs[i].sig) ? L : R);
      if (!host) continue;
      host.x0 = Math.min(host.x0, runs[i].x0);
      host.x1 = Math.max(host.x1, runs[i].x1);
      runs.splice(i, 1); i--;
    }
    if (runs.length < 2) return [{bbox: box, sig: runs[0] ? runs[0].sig : null}];

    // 조각들의 x 범위가 서로 물릴 수 있다. 경계를 중간점으로 잘라 겹치지 않게 한다.
    // 이걸 안 하면 구간이 겹쳐 같은 글자가 두 블록에 들어간다.
    for (let i = 0; i < runs.length - 1; i++) {
      if (runs[i].x1 <= runs[i + 1].x0) continue;
      const mid = Math.round((runs[i].x1 + runs[i + 1].x0) / 2);
      runs[i].x1 = mid;
      runs[i + 1].x0 = mid;
    }

    // 구간마다 실제 잉크로 다시 타이트하게 잰다.
    return runs.map((r) => {
      const t = tighten(ink, W, {
        x0: box.x0 + r.x0, y0: box.y0, x1: box.x0 + r.x1, y1: box.y1,
      });
      return t ? {bbox: t, sig: r.sig} : null;
    }).filter(Boolean);
  }


  /* ---------- 7-3 여러 줄 그룹핑 ---------- */

  function groupLines(lines) {
    const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
    const blocks = [];
    for (const ln of sorted) {
      const b = ln.bbox, h = b.y1 - b.y0;
      const host = blocks.find((g) => {
        const last = g.lines[g.lines.length - 1].bbox;
        const lh = last.y1 - last.y0;
        const gap = b.y0 - last.y1;
        const overlapX = Math.min(b.x1, last.x1) - Math.max(b.x0, last.x0);
        const ratio = Math.max(h, lh) / Math.min(h, lh);
        const la = colorSig(g.lines[g.lines.length - 1].color.top, g.lines[0].bgColor);
        const lb = colorSig(ln.color.top, ln.bgColor);
        const same = !la || !lb || sigDist(la, lb) <= SIG_SPLIT;
        return g.tier === ln.tier && gap >= -2 && gap <= lh * LINE_GAP
          && overlapX > 0 && ratio <= LINE_RATIO && same;
      });
      if (host) host.lines.push(ln);
      else blocks.push({tier: ln.tier, lines: [ln]});
    }
    return blocks.map((g, i) => {
      const bb = g.lines.reduce((a, l) => ({
        x0: Math.min(a.x0, l.bbox.x0), y0: Math.min(a.y0, l.bbox.y0),
        x1: Math.max(a.x1, l.bbox.x1), y1: Math.max(a.y1, l.bbox.y1),
      }), {x0: 1e9, y0: 1e9, x1: 0, y1: 0});
      const f = g.lines[0];
      return {
        id: `b${i}`, bbox: bb, tier: g.tier, bgColor: f.bgColor || null,
        lines: g.lines.map((l) => ({bbox: l.bbox})),
        colorTop: f.color.top, colorBottom: f.color.bottom, opacity: f.color.opacity,
        originalText: '', editedText: '', dirty: false, saved: false,
        locked: g.tier === 'C',
      };
    });
  }

  /* ---------- 진입점 ---------- */

  function detect(img) {
    const {width: W, height: H, data: d} = img;
    const lines = [];

    // 1차 — 알파 마스크에서 유형 A 텍스트
    const alpha = new Uint8Array(W * H);
    for (let i = 3, p = 0; i < d.length; i += 4, p++) alpha[p] = d[i] > ALPHA_T ? 1 : 0;
    const smoothA = rlsaAuto(alpha, W, H);
    for (const r of components(smoothA, W, H, 30)) {
      const b = tighten(alpha, W, r);
      if (!b || !textLike(b)) continue;
      const t = judgeTier(d, W, H, b, 3);
      if (t.tier !== 'A') continue;         // 불투명 덩어리는 2차에서 다룬다
      const wA = (x, y) => alpha[y * W + x] ? d[(y * W + x) * 4 + 3] / 255 : 0;
      for (const {bbox: seg} of splitByColor(d, W, alpha, b, null, null)) {
        if (!textLike(seg)) continue;
        lines.push({bbox: seg, tier: 'A', color: extractColor(d, W, seg, wA)});
      }
    }

    // 2차 — 단색 패치 안의 글자 (유형 B)
    for (const p of solidPatches(d, W, H)) {
      const {bbox: pb, color: bg} = p;
      const inPatch = new Uint8Array(W * H);
      for (const i of p.pixels) inPatch[i] = 1;
      const ink = new Uint8Array(W * H);
      for (let y = pb.y0; y < pb.y1; y++) for (let x = pb.x0; x < pb.x1; x++) {
        const q = y * W + x, i = q * 4;
        if (!inPatch[q] || d[i + 3] <= 200) continue;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > FAR)
          ink[q] = 1;
      }
      const smoothB = rlsaAuto(ink, W, H);
      for (const r of components(smoothB, W, H, 30)) {
        const b = tighten(ink, W, r);
        if (!b || !textLike(b)) continue;
        if (lines.some((l) => overlaps(l.bbox, b))) continue;   // 1차 결과와 중복 방지
        const t = judgeTier(d, W, H, b, Math.max(4, Math.round((b.y1 - b.y0) * 0.35)));
        if (t.tier === 'A') continue;
        const ref = t.bgColor || bg;
        const distAt = (x, y) => {
          const i = (y * W + x) * 4;
          return Math.abs(d[i] - ref[0]) + Math.abs(d[i + 1] - ref[1]) + Math.abs(d[i + 2] - ref[2]);
        };
        // 배경에서 가장 먼 픽셀들만 글자 '코어'로 본다. 거리에 비례한 가중치를
        // 주면 경계 픽셀이 절반 넘는 무게를 받아 색이 배경 쪽으로 끌려간다
        // (검은 원 위 흰 글자가 회색으로 잡히던 문제).
        for (const {bbox: seg, sig} of splitByColor(d, W, ink, b, distAt, ref)) {
          if (!textLike(seg)) continue;
          // 구간의 색 방향과 맞는 픽셀만 후보로 둔다. 경계에 다른 색이 몇 픽셀만
          // 섞여도, 그쪽이 배경에서 훨씬 멀면 코어 기준을 장악해 정작 이 구간의
          // 색이 통째로 배제된다(파란 라벨이 검정으로 잡히던 문제).
          const match = (x, y) => {
            if (!ink[y * W + x]) return false;
            if (!sig) return true;
            const i = (y * W + x) * 4;
            const s2 = colorSig([d[i], d[i + 1], d[i + 2]], ref);
            return !s2 || sigDist(s2, sig) <= SIG_SPLIT;
          };
          let maxD = 0;
          for (let y = seg.y0; y < seg.y1; y++) for (let x = seg.x0; x < seg.x1; x++)
            if (match(x, y)) maxD = Math.max(maxD, distAt(x, y));
          const coreD = maxD * CORE_R;
          lines.push({
            bbox: seg, tier: t.tier, bgColor: ref,
            color: extractColor(d, W, seg, (x, y) =>
              (match(x, y) && distAt(x, y) >= coreD) ? 1 : 0),
          });
        }
      }
    }

    return groupLines(lines);
  }

  const overlaps = (a, b) => {
    const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ix <= 0 || iy <= 0) return false;
    const inter = ix * iy;
    return inter / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)) > 0.5;
  };

  return {detect, ALPHA_T};
})();

if (typeof module !== 'undefined') module.exports = Detect;
