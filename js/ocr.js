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
  function preprocess(img, block, opts = {}) {
    const targetH = opts.targetH || TARGET_H;
    const binarize = !!opts.binarize;
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
    const scale = Math.min(MAX_SCALE, Math.max(1, targetH / lineH));

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

    // 확대하면 글자 가장자리가 회색으로 번진다. 이진화하면 경계가 또렷해지지만
    // 가는 획이 끊길 수 있다. 어느 쪽이 나은지는 실측으로 정한다(부록 P).
    if (binarize) {
      const im = ctx.getImageData(0, 0, out.width, out.height);
      const q = im.data;
      let sum = 0, n = 0;
      for (let i = 0; i < q.length; i += 4) { sum += q[i]; n++; }
      const t = sum / n;                       // 평균 밝기를 문턱으로
      for (let i = 0; i < q.length; i += 4) {
        const v = q[i] < t ? 0 : 255;
        q[i] = q[i + 1] = q[i + 2] = v;
      }
      ctx.putImageData(im, 0, 0);
    }
    return out;
  }

  /* ---------- 한글↔라틴 혼동 교정 (v1.8) ----------
   *
   * `kor+eng` 는 한글을 라틴 글자로 잘못 읽는 일이 잦다. 실측(샘플 B):
   *   핵집 → “HS,  핵심집약 → BYU
   * `kor` 단독으로 읽으면 둘 다 맞는다. 그런데 `kor` 단독을 기본으로 삼을 수는
   * 없다 — `EVENT` → `ㄷ66411`, `UPGRADE` → `1『<ㅅ^` 로 영문이 전부 깨진다.
   *
   * 낱말 신뢰도로 고르는 것도 안 된다. 정답인 `핵`이 21%, 오답인 `“HS`가 62% 로
   * **신뢰도가 정답 쪽을 가리키지 않는다.**
   *
   * 두 가지를 함께 본다.
   *   1. 한글이 섞인 블록에서, 그 라틴 낱말만 유독 신뢰도가 낮은가
   *   2. 같은 자리를 한국어 전용으로 읽었을 때 **완성형 한글**이 나오는가
   *
   * 2가 핵심이다. 실측에서 정답인 `UP!`(신뢰도 16)도 1에는 걸리지만, 한국어
   * 전용이 내놓는 것이 `1ㅁ!!` 라 완성형 한글이 아니어서 걸러진다. 반대로
   * `“HS`·`BYU` 는 `“핵집`·`핵심집약` 이 나와 갈아탄다.
   */
  const HANGUL = /[가-힣]/;
  const CONF_DROP = 20;   // 한글 낱말 중앙값보다 이만큼 낮으면 의심한다
  const MIN_HANGUL_PCT = 30;

  let korWorker = null;
  async function korOnly() {
    if (korWorker) return korWorker;
    korWorker = await Tesseract.createWorker(['kor'], 1, {
      workerPath: BASE + 'worker.min.js', corePath: BASE,
      langPath: BASE + 'lang', gzip: false,
    });
    await korWorker.setParameters({
      tessedit_pageseg_mode: '6', preserve_interword_spaces: '1',
    });
    return korWorker;
  }

  /** 인식 결과에서 줄 구조를 유지한 채 낱말을 꺼낸다. */
  function linesOf(data) {
    const out = [];
    const dig = (o) => {
      if (!o) return;
      if (Array.isArray(o.words) && o.words.length) {
        const ws = o.words.filter((x) => (x.text || '').trim()).map((x) => ({
          t: x.text.trim(), c: x.confidence,
          x0: x.bbox.x0, x1: x.bbox.x1, y0: x.bbox.y0, y1: x.bbox.y1,
        }));
        if (ws.length) out.push(ws);
      }
      for (const k of ['blocks', 'paragraphs', 'lines']) {
        if (Array.isArray(o[k])) o[k].forEach(dig);
      }
    };
    (data.blocks || []).forEach(dig);
    return out;
  }

  const median = (a) => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null;

  /**
   * 획 굵기 분포 — 글자인지 그림인지 가르는 단서.
   *
   * 글자는 가는 세로획과 긴 가로획이 섞여 있어 가로 런 길이의 90분위가 중앙값의
   * 여러 배다. 포크·수저 같은 아이콘은 통짜라 런 길이가 고르다.
   * 실측(샘플 B): 아이콘 1.7·1.8 vs 글자 2.3~4.3.
   */
  function strokeRatio(canvas) {
    const g = canvas.getContext('2d', {willReadFrequently: true});
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const W = canvas.width, H = canvas.height;
    const runs = [];
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4] < 128) n++;
        else { if (n) runs.push(n); n = 0; }
      }
      if (n) runs.push(n);
    }
    if (runs.length < 8) return null;
    runs.sort((a, b) => a - b);
    const med = runs[runs.length >> 1] || 1;
    return runs[Math.floor(runs.length * 0.9)] / med;
  }

  /**
   * 라틴으로 잘못 읽힌 한글 낱말을 한국어 전용 결과로 갈아끼운다.
   * @returns {text, fixed[]} — 고친 낱말 목록(검증용)
   */
  async function fixLatin(canvas, lines) {
    const all = lines.flat();
    const joined = all.map((w) => w.t).join('');
    const chars = joined.replace(/\s/g, '').length;
    if (!chars) return null;
    const hangulPct = (joined.match(/[가-힣]/g) || []).length / chars * 100;
    if (hangulPct < MIN_HANGUL_PCT) return null;      // 영문 블록은 건드리지 않는다

    const med = median(all.filter((w) => HANGUL.test(w.t)).map((w) => w.c));
    if (med === null) return null;
    const suspect = all.filter((w) =>
      /[A-Za-z]/.test(w.t) && !HANGUL.test(w.t) && w.c < med - CONF_DROP);
    if (!suspect.length) return null;

    const w = await korOnly();
    const kr = await w.recognize(canvas, {}, {blocks: true, text: true});
    const kw = linesOf(kr.data).flat();

    // 낱말을 다시 이어 붙이면 띄어쓰기가 깨진다. 한국어는 한 음절이 한 낱말로
    // 잘리는 일이 흔해, 낱말 사이를 공백으로 메우면 `핵 1 권 만` 이 된다.
    // 그래서 **원문 문자열에서 그 낱말만 바꿔 끼운다.**
    const fixed = [];
    for (const a of suspect) {
      // '한국어 낱말이 의심 구간 안에 들어오는가' 로 본다. 의심 낱말 폭의 절반을
      // 기준으로 삼으면 `“HS` 자리에서 `핵` 하나만 잡히고 `집` 이 빠진다 — 한국어
      // 쪽은 한 음절씩 잘리는 일이 흔해 낱말 하나하나가 훨씬 짧기 때문이다.
      const ov = kw.filter((z) =>
        Math.min(a.x1, z.x1) - Math.max(a.x0, z.x0) > (z.x1 - z.x0) * 0.5 &&
        Math.min(a.y1, z.y1) - Math.max(a.y0, z.y0) > (z.y1 - z.y0) * 0.5);
      if (!ov.length) continue;
      const t = ov.sort((m, n) => m.x0 - n.x0).map((z) => z.t).join('');
      // 완성형 한글이 나올 때만 믿는다. 낱자모(ㅁ)·기호만 나오면 그냥 노이즈다.
      if (!HANGUL.test(t) || t === a.t) continue;
      fixed.push({from: a.t, to: t});
    }
    return fixed.length ? {fixed} : null;
  }

  /** 블록 하나를 인식한다. 실패하면 빈 문자열을 돌려주고 예외를 던지지 않는다. */
  async function recognizeBlock(img, block) {
    const canvas = preprocess(img, block);
    await worker.setParameters({
      tessedit_pageseg_mode: '6',   // 균일 블록. 한 줄짜리에도 7보다 안정적이다
      preserve_interword_spaces: '1',
    });
    try {
      const {data} = await worker.recognize(canvas, {}, {blocks: true, text: true});
      const text = (data.text || '').replace(/\s*\n\s*/g, '\n').trim();
      let fix = null;
      try { fix = await fixLatin(canvas, linesOf(data)); }
      catch (e) { /* 교정은 보조다. 실패해도 1차 결과를 쓴다 */ }
      let out = text;
      for (const f of (fix ? fix.fixed : [])) {
        const i = out.indexOf(f.from);
        if (i >= 0) out = out.slice(0, i) + f.to + out.slice(i + f.from.length);
      }
      return {
        text: out, confidence: data.confidence ?? 0,
        strokeRatio: strokeRatio(canvas),
        fixedWords: (fix ? fix.fixed : []).map((f) => `${f.from} → ${f.to}`),
      };
    } catch (e) {
      return {text: '', confidence: 0, error: String(e)};
    }
  }

  async function terminate() {
    if (worker) { await worker.terminate(); worker = null; booting = null; }
    if (korWorker) { await korWorker.terminate(); korWorker = null; }
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
