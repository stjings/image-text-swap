/* typo.js — 타이포 속성 계측 (폰트·크기·자간·행간·정렬)
 * PLAN.md 7-9
 *
 * 왜 나누는가
 *   "유사도 67%" 하나로는 담당자가 판단할 수 없다. 모양이 안 닮은 것과 글자가
 *   옆으로 밀리는 것은 전혀 다른 문제인데, 한 숫자로 뭉치면 구분이 안 된다.
 *   디자인팀이 자간·행간을 손으로 만진다고 한 이상 그 값 자체도 보여야 한다.
 *
 * 무엇을 재는가
 *   **원문을 다시 그려 원본과 맞춰 본다.** 편집 결과가 아니라 원문이다.
 *   원문조차 제자리에 못 놓으면 편집 결과는 당연히 못 놓는다. 이 수치가
 *   "이 블록은 100% 교체 가능한가"에 대한 답이다.
 *
 *   폰트  실루엣 IoU
 *   크기  렌더 잉크 높이 vs 원본 줄 높이
 *   자간  렌더 잉크 폭   vs 원본 줄 폭     (자간 상한에 걸리면 여기서 떨어진다)
 *   정렬  렌더 잉크 왼쪽 x vs 원본 줄 왼쪽 x
 *   행간  줄 간격은 원본 값을 그대로 재사용하므로 '재현 오차'가 없다.
 *         점수를 매기지 않고 측정값만 보여 준다 — 가짜 100%를 적지 않는다.
 *
 * 계측은 compose.js 의 layout/inkX 를 그대로 쓴다. 다른 경로로 계산하면
 * "판별 화면에서 본 수치"와 "실제로 찍히는 글자"가 갈린다.
 */
'use strict';

const Typo = (() => {

  // 총합 가중치. 행간은 재현 오차가 없으므로 총합에서 뺀다.
  const W = {font: 0.40, size: 0.20, tracking: 0.25, align: 0.15};

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

  const ALIGN_LABEL = {left: '왼쪽', center: '가운데', right: '오른쪽'};

  /**
   * @returns null | {
   *   font:{label,score}, size:{px,score}, tracking:{px,pct,capped,score},
   *   leading:{px,ratio,natural,delta}|null, align:{value,label,score},
   *   total, lines
   * }
   */
  function measure(img, block, font) {
    if (!block.originalText || !block.lines.length) return null;
    const {setFont, inkMetrics, fitTracking, layout, inkX, TRACK_MAX} = Compose.util;
    const ctx = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
    const L = layout(ctx, block, font);
    if (!L.size) return null;

    const rows = [];
    let drift = 0;
    for (let i = 0; i < L.boxes.length; i++) {
      const text = (L.srcLines[i] || '').trim();
      if (!text) continue;
      const box = L.boxes[i];
      const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
      if (bw < 1 || bh < 1) continue;

      const track = fitTracking(ctx, font, text, L.size, bw);
      setFont(ctx, font, L.size, track);
      const m = inkMetrics(ctx, text);
      rows.push({
        track,
        size: clamp01(1 - Math.abs(m.h - bh) / bh),
        tracking: clamp01(1 - Math.abs(m.w - bw) / bw),
        align: clamp01(1 - Math.abs(inkX(L.align, box, m) - box.x0) / bw),
      });

      // 문구 길이가 바뀌면 글자가 옆으로 얼마나 밀리는가. 가운데·오른쪽 정렬은
      // 차이의 절반 또는 전부를 그대로 옮긴다. 담당자가 "이 블록을 고치면 자리가
      // 흔들리나"를 판단하는 데 필요한 값이라 실제로 한 글자 지워 재 본다.
      if (text.length > 1) {
        const cut = text.slice(0, -1);
        setFont(ctx, font, L.size, track);
        const shift = inkX(L.align, box, inkMetrics(ctx, cut)) - box.x0;
        drift = Math.max(drift, Math.abs(shift));
      }
    }
    if (!rows.length) return null;

    const track = mean(rows.map((r) => r.track));
    const cap = L.size * TRACK_MAX;
    // 자간이 상한에 닿았다는 것은 이 폰트로는 원본 폭을 못 맞춘다는 뜻이다.
    const capped = Math.abs(Math.abs(track) - cap) < 0.01;

    // 폰트가 자연스럽게 갖는 줄 높이. 원본 행간이 여기서 얼마나 벗어났는지가
    // 곧 "디자이너가 행간을 얼마나 만졌는가"다.
    setFont(ctx, font, L.size, 0);
    const fm = ctx.measureText('가힣');
    const natural = (fm.fontBoundingBoxAscent || 0) + (fm.fontBoundingBoxDescent || 0);

    const score = {
      font: clamp01(FontMatch.scoreFont(img, block, font) ?? 0),
      size: mean(rows.map((r) => r.size)),
      tracking: mean(rows.map((r) => r.tracking)),
      align: mean(rows.map((r) => r.align)),
    };
    const total = Object.keys(W).reduce((s, k) => s + W[k] * score[k], 0);

    return {
      font: {label: FontMatch.label(font), family: font.family, weight: font.weight,
             score: score.font},
      size: {px: L.size, score: score.size},
      tracking: {px: track, pct: L.size ? track / L.size * 100 : 0, capped, score: score.tracking},
      leading: L.boxes.length > 1 ? {
        px: L.pitch,
        ratio: L.size ? L.pitch / L.size : 0,
        natural: natural,
        delta: natural ? (L.pitch - natural) / natural * 100 : 0,
      } : null,
      align: {value: L.align, label: ALIGN_LABEL[L.align] || L.align,
              drift, score: score.align},
      total, lines: rows.length,
    };
  }

  return {measure, W, ALIGN_LABEL};
})();
