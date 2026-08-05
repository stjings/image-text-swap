/* app.js — 플로우 오케스트레이션·상태관리
 *
 * M1 범위: 업로드(드롭/파일선택) → Canvas 로드 → 체커보드 미리보기 → 기본 분석.
 * 블록 검출·OCR(M2), 합성(M4), 폰트 판별(M5)은 각각 detect/ocr/compose/fontmatch 로 붙는다.
 */
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  fileInput: $('fileInput'), pickBtn: $('pickBtn'), pickBtn2: $('pickBtn2'),
  resetBtn: $('resetBtn'), fileName: $('fileName'),
  stage: $('stage'), dropzone: $('dropzone'), viewport: $('viewport'),
  canvas: $('preview'), overlay: $('overlay'), bgToggle: $('bgToggle'),
  info: $('imgInfo'), blockCount: $('blockCount'), blockList: $('blockList'),
};

/** 앱 상태 (PLAN.md 10장). M1에서는 blocks 가 비어 있다. */
const state = {
  fileName: null,
  sourceImage: null,   // ImageBitmap
  imageData: null,     // 원본 픽셀. 이후 단계가 전부 여기서 출발한다
  hasAlpha: false,
  stats: null,
  blocks: [],
  fontMode: 'auto',
  selectedFont: null,
};

const ALPHA_T = 20;   // 잉크/투명 판정 임계 (PLAN.md 7-1, 7-3)

/* ---------------- 이미지 로드 ---------------- */

const ACCEPT = ['image/png', 'image/jpeg'];

async function loadFile(file) {
  if (!file) return;
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

  showImage(file);
}

/** 알파 분포 요약. 이 이미지가 어느 정도 처리 가능한지 사용자가 미리 알 수 있게 한다. */
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

/* ---------------- 표시 ---------------- */

function showImage(file) {
  el.dropzone.hidden = true;
  el.viewport.hidden = false;
  el.resetBtn.hidden = false;
  el.fileName.textContent = file.name;
  renderInfo(file);
  renderBlockList();
}

function renderInfo(file) {
  const {total, clear, semi, opaque} = state.stats;
  const pct = (n) => (n / total * 100).toFixed(1) + '%';
  const fmt = file.type === 'image/png' ? 'PNG' : 'JPG';
  const kb = (file.size / 1024).toFixed(0);

  const rows = [
    ['형식', `${fmt} · ${kb} KB`],
    ['크기', `${el.canvas.width} × ${el.canvas.height}`],
    ['투명', pct(clear)],
    ['반투명', pct(semi)],
    ['불투명', pct(opaque)],
  ];
  el.info.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')
    + (state.hasAlpha ? '' :
      `<div><dt>알파 채널</dt><dd class="warn">없음</dd></div>`);
  el.info.hidden = false;
}

function renderBlockList() {
  // M2에서 검출 결과로 채운다. M1은 빈 상태만 정확히 보여준다.
  el.blockCount.textContent = state.blocks.length ? String(state.blocks.length) : '—';
  if (!state.blocks.length) {
    const hint = state.sourceImage
      ? '이미지를 읽었습니다. 텍스트 블록 검출은 M2에서 붙습니다.'
      : '이미지를 올리면 검출된 텍스트 블록이 여기에 표시됩니다.';
    el.blockList.innerHTML =
      `<p class="placeholder">${hint}<small>M2: 알파 검출 · 블록 분리 · OCR</small></p>`;
  }
}

function reset() {
  state.fileName = null;
  state.sourceImage = null;
  state.imageData = null;
  state.stats = null;
  state.blocks = [];
  el.viewport.hidden = true;
  el.dropzone.hidden = false;
  el.info.hidden = true;
  el.resetBtn.hidden = true;
  el.fileName.textContent = '';
  el.fileInput.value = '';
  el.overlay.innerHTML = '';
  renderBlockList();
}

/* ---------------- 이벤트 ---------------- */

const openPicker = () => el.fileInput.click();
el.pickBtn.addEventListener('click', openPicker);
el.pickBtn2.addEventListener('click', openPicker);
el.resetBtn.addEventListener('click', reset);
el.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));

// 드래그&드롭. 페이지 어디에 떨어뜨려도 받되, 강조는 스테이지에만 준다.
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

// 검증 스크립트에서 파일 입력 없이 이미지를 주입할 때 쓴다.
window.__app = {state, loadFile};
