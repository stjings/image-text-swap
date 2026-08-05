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
  const RLSA_X = 26;       // 가로 런렝스 평활 — 글자를 줄로 잇는다
  const RLSA_Y = 4;        // 세로 런렝스 평활
  const MIN_H = 7, MAX_H = 170;   // 텍스트 줄 높이 허용 범위
  const MIN_W = 8;
  const PATCH_MIN = 1500;  // 단색 패치 최소 픽셀 수

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
        const lc = g.lines[g.lines.length - 1].color.top, c = ln.color.top;
        const dc = Math.abs(lc[0] - c[0]) + Math.abs(lc[1] - c[1]) + Math.abs(lc[2] - c[2]);
        return g.tier === ln.tier && gap >= -2 && gap <= lh * 1.5
          && overlapX > 0 && ratio <= 1.3 && dc <= 90;
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
    const smoothA = rlsa(alpha, W, H, RLSA_X, RLSA_Y);
    for (const r of components(smoothA, W, H, 30)) {
      const b = tighten(alpha, W, r);
      if (!b || !textLike(b)) continue;
      const t = judgeTier(d, W, H, b, 3);
      if (t.tier !== 'A') continue;         // 불투명 덩어리는 2차에서 다룬다
      lines.push({
        bbox: b, tier: 'A',
        color: extractColor(d, W, b, (x, y) =>
          alpha[y * W + x] ? d[(y * W + x) * 4 + 3] / 255 : 0),
      });
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
      const smoothB = rlsa(ink, W, H, RLSA_X, RLSA_Y);
      for (const r of components(smoothB, W, H, 30)) {
        const b = tighten(ink, W, r);
        if (!b || !textLike(b)) continue;
        if (lines.some((l) => overlaps(l.bbox, b))) continue;   // 1차 결과와 중복 방지
        const t = judgeTier(d, W, H, b, Math.max(4, Math.round((b.y1 - b.y0) * 0.35)));
        if (t.tier === 'A') continue;
        const ref = t.bgColor || bg;
        lines.push({
          bbox: b, tier: t.tier, bgColor: ref,
          color: extractColor(d, W, b, (x, y) => {
            const q = y * W + x;
            if (!ink[q]) return 0;
            const i = q * 4;
            const dist = Math.abs(d[i] - ref[0]) + Math.abs(d[i + 1] - ref[1]) + Math.abs(d[i + 2] - ref[2]);
            return Math.min(1, dist / (FAR * 2));   // 배경에 가까운 경계 픽셀은 약하게
          }),
        });
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
