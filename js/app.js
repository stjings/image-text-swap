/* app.js — 플로우 오케스트레이션·상태관리
 *
 * M1: 업로드 → Canvas 로드 → 체커보드 미리보기
 * M2: 블록 검출(detect.js) → 오버레이 → OCR(ocr.js) → 블록 목록
 * 편집·저장(M3), 합성(M4), 폰트(M5)는 이후에 붙는다.
 */
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  fileInput: $('fileInput'), pickBtn: $('pickBtn'), pickBtn2: $('pickBtn2'),
  resetBtn: $('resetBtn'), fileName: $('fileName'),
  stage: $('stage'), dropzone: $('dropzone'), viewport: $('viewport'),
  canvas: $('preview'), overlay: $('overlay'), bgToggle: $('bgToggle'),
  info: $('imgInfo'), blockCount: $('blockCount'), blockList: $('blockList'),
  status: $('status'),
};

/** 앱 상태 (PLAN.md 10장). */
const state = {
  fileName: null,
  sourceImage: null,
  imageData: null,
  hasAlpha: false,
  stats: null,
  blocks: [],
  selectedId: null,
  timing: null,
  fontMode: 'auto',
  selectedFont: null,
  analyzing: false,
};

const ALPHA_T = 20;
const TIER_LABEL = {A: '투명 배경', B: '단색 배경', C: '편집 불가'};
// 실측상 인식에 성공한 블록은 86~96%, 실패한 블록은 0~79% 였다.
// 신뢰도가 성공/실패를 꽤 잘 가르므로 낮은 블록을 눈에 띄게 표시한다.
const CONF_LOW = 70;

/* ---------------- 이미지 로드 ---------------- */

const ACCEPT = ['image/png', 'image/jpeg'];

async function loadFile(file) {
  if (!file || state.analyzing) return;
  if (!ACCEPT.includes(file.type)) {
    alert('PNG 또는 JPG 파일만 열 수 있습니다.');
    return;
  }
  const bitmap = await createImageBitmap(file);
  const {width: w, height: h} = bitmap;

  const ctx = el.canvas.getContext('2d', {willReadFrequently: true});
  el.canvas.width = w;
  el.canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);

  state.fileName = file.name;
  state.sourceImage = bitmap;
  state.imageData = ctx.getImageData(0, 0, w, h);
  state.stats = analyze(state.imageData);
  state.hasAlpha = state.stats.semi > 0 || state.stats.clear > 0;
  state.blocks = [];
  state.selectedId = null;

  el.dropzone.hidden = true;
  el.viewport.hidden = false;
  el.resetBtn.hidden = false;
  el.fileName.textContent = file.name;
  renderInfo(file);

  await runAnalysis();
}

/** 알파 분포 요약. 이 이미지가 어느 정도 처리 가능한지 미리 알 수 있게 한다. */
function analyze(img) {
  const d = img.data;
  const total = img.width * img.height;
  let clear = 0, semi = 0, opaque = 0;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a <= ALPHA_T) clear++;
    else if (a < 255) semi++;
    else opaque++;
  }
  return {total, clear, semi, opaque};
}

/* ---------------- 분석 파이프라인 ---------------- */

async function runAnalysis() {
  state.analyzing = true;
  try {
    setStatus('텍스트 블록을 찾는 중…');
    await raf();
    const t0 = performance.now();
    state.blocks = Detect.detect(state.imageData);
    state.timing = {detect: Math.round(performance.now() - t0), ocr: 0};
    renderOverlay();
    renderBlockList();

    if (!state.blocks.length) { setStatus(null); return; }

    const t1 = performance.now();
    setStatus('OCR 엔진 준비 중… (최초 1회만 오래 걸립니다)');
    await OCR.init((m) => {
      if (m.status && typeof m.progress === 'number') {
        setStatus(`${ocrStatusLabel(m.status)} ${Math.round(m.progress * 100)}%`);
      }
    });

    for (let i = 0; i < state.blocks.length; i++) {
      const b = state.blocks[i];
      setStatus(`텍스트 인식 중… ${i + 1} / ${state.blocks.length}`);
      await raf();
      const r = await OCR.recognizeBlock(state.imageData, b);
      b.originalText = r.text;
      b.editedText = r.text;
      b.confidence = r.confidence;
      renderBlockList();
    }
    state.timing.ocr = Math.round(performance.now() - t1);
    setStatus(null);
  } catch (e) {
    setStatus(`분석 실패: ${e.message}`, true);
    console.error(e);
  } finally {
    state.analyzing = false;
  }
}

const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

function ocrStatusLabel(s) {
  if (s.includes('traineddata')) return '언어 데이터 내려받는 중…';
  if (s.includes('initializ')) return '엔진 초기화 중…';
  if (s.includes('load')) return '엔진 로딩 중…';
  if (s.includes('recognizing')) return '인식 중…';
  return s;
}

/* ---------------- 표시 ---------------- */

function setStatus(text, isError = false) {
  el.status.hidden = !text;
  el.status.textContent = text || '';
  el.status.classList.toggle('err', isError);
}

function renderInfo(file) {
  const {total, clear, semi, opaque} = state.stats;
  const pct = (n) => (n / total * 100).toFixed(1) + '%';
  const fmt = file.type === 'image/png' ? 'PNG' : 'JPG';
  const rows = [
    ['형식', `${fmt} · ${(file.size / 1024).toFixed(0)} KB`],
    ['크기', `${el.canvas.width} × ${el.canvas.height}`],
    ['투명', pct(clear)],
    ['반투명', pct(semi)],
    ['불투명', pct(opaque)],
  ];
  el.info.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')
    + (state.hasAlpha ? '' : `<div><dt>알파 채널</dt><dd class="warn">없음</dd></div>`);
  el.info.hidden = false;
}

/** 블록 경계를 이미지 위에 겹쳐 그린다.
 *  캔버스는 CSS로만 축소되므로 % 좌표를 쓰면 확대/축소와 무관하게 맞는다. */
function renderOverlay() {
  const W = el.canvas.width, H = el.canvas.height;
  el.overlay.innerHTML = state.blocks.map((b) => {
    const {x0, y0, x1, y1} = b.bbox;
    const style = `left:${x0 / W * 100}%;top:${y0 / H * 100}%;`
      + `width:${(x1 - x0) / W * 100}%;height:${(y1 - y0) / H * 100}%`;
    return `<div class="bk bk-${b.tier}" data-id="${b.id}" style="${style}"`
      + ` title="${TIER_LABEL[b.tier]}"><i>${b.tier}</i></div>`;
  }).join('');
}

function renderBlockList() {
  el.blockCount.textContent = state.blocks.length ? String(state.blocks.length) : '—';

  if (!state.blocks.length) {
    el.blockList.innerHTML = state.sourceImage
      ? `<p class="placeholder">텍스트 블록을 찾지 못했습니다.<small>투명 배경 또는 단색 배경 위의 글자만 검출합니다.</small></p>`
      : `<p class="placeholder">이미지를 올리면 검출된 텍스트 블록이 여기에 표시됩니다.</p>`;
    return;
  }

  el.blockList.innerHTML = state.blocks.map((b) => {
    const txt = b.originalText
      ? escapeHtml(b.originalText).replace(/\n/g, '<br>')
      : (b.originalText === '' && 'confidence' in b
        ? '<span class="fail">인식 실패</span>'
        : '<span class="pending">인식 대기…</span>');
    const low = typeof b.confidence === 'number' && b.originalText && b.confidence < CONF_LOW;
    const conf = typeof b.confidence === 'number' && b.originalText
      ? `<span class="conf${low ? ' low' : ''}" title="OCR 신뢰도">${Math.round(b.confidence)}%</span>` : '';
    return `<div class="item item-${b.tier}${b.locked ? ' locked' : ''}${low ? ' lowconf' : ''}" data-id="${b.id}">
      <div class="item-head">
        <span class="badge badge-${b.tier}" title="${TIER_LABEL[b.tier]}">${b.locked ? '🔒 ' : ''}${b.tier}</span>
        <span class="dim">${b.lines.length}줄 · ${b.bbox.x1 - b.bbox.x0}×${b.bbox.y1 - b.bbox.y0}</span>
        ${conf}
      </div>
      <div class="item-text">${txt}</div>
      ${low ? '<p class="hint">인식 신뢰도가 낮습니다. 문구를 확인해 주세요.</p>' : ''}
    </div>`;
  }).join('');
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

function highlight(id) {
  el.overlay.querySelectorAll('.bk').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
  el.blockList.querySelectorAll('.item').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
}

function reset() {
  Object.assign(state, {
    fileName: null, sourceImage: null, imageData: null, stats: null,
    blocks: [], selectedId: null, analyzing: false,
  });
  el.viewport.hidden = true;
  el.dropzone.hidden = false;
  el.info.hidden = true;
  el.resetBtn.hidden = true;
  el.fileName.textContent = '';
  el.fileInput.value = '';
  el.overlay.innerHTML = '';
  setStatus(null);
  renderBlockList();
}

/* ---------------- 이벤트 ---------------- */

const openPicker = () => el.fileInput.click();
el.pickBtn.addEventListener('click', openPicker);
el.pickBtn2.addEventListener('click', openPicker);
el.resetBtn.addEventListener('click', reset);
el.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) el.stage.classList.add('dragover');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; el.stage.classList.remove('dragover'); }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.stage.classList.remove('dragover');
  loadFile(e.dataTransfer.files[0]);
});

el.bgToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-bg]');
  if (!btn) return;
  [...el.bgToggle.children].forEach((b) => b.classList.toggle('on', b === btn));
  el.stage.className = 'stage bg-' + btn.dataset.bg;
});

// 목록 ↔ 오버레이 상호 강조
el.blockList.addEventListener('mouseover', (e) => {
  const it = e.target.closest('.item');
  if (it) highlight(it.dataset.id);
});
el.blockList.addEventListener('mouseleave', () => highlight(null));
el.overlay.addEventListener('mouseover', (e) => {
  const bk = e.target.closest('.bk');
  if (bk) highlight(bk.dataset.id);
});

window.__app = {state, loadFile, runAnalysis};
