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
  status: $('status'), filterBar: $('filterBar'),
  editor: $('editor'), editorTitle: $('editorTitle'), editorOrig: $('editorOrig'),
  editorText: $('editorText'), editorHint: $('editorHint'), editorClose: $('editorClose'),
  saveBtn: $('saveBtn'), revertBtn: $('revertBtn'),
  dirtyCount: $('dirtyCount'), composeBtn: $('composeBtn'),
  toggleBtn: $('toggleBtn'), downloadBtn: $('downloadBtn'), notes: $('notes'),
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
  filter: 'all',
  timing: null,
  result: null,        // 합성 결과 canvas (M4)
  showing: 'original',  // 'original' | 'result'
  composeNotes: [],
  fontMode: 'auto',
  selectedFont: null,
  analyzing: false,
};

const ALPHA_T = 20;
const TIER_LABEL = {A: '투명 배경', B: '단색 배경', C: '편집 불가'};
// 실측상 인식에 성공한 블록은 86~96%, 실패한 블록은 0~79% 였다.
// 신뢰도가 성공/실패를 꽤 잘 가르므로 낮은 블록을 눈에 띄게 표시한다.
const CONF_LOW = 70;
// M4는 고정 폰트로 합성한다. 후보 판별은 M5에서 이 값을 대체한다.
const DEFAULT_FONT = {family: 'Noto Sans KR', weight: 700};

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
    renderDirtyCount();

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
      b.editedText = r.text;      // 확정된 문구. M4 합성이 쓰는 값
      b.draft = r.text;           // 편집 중인 값
      b.dirty = false;
      b.confidence = r.confidence;
      if (b.id === state.selectedId) renderEditor();
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
  const shown = new Set(visibleBlocks().map((b) => b.id));
  el.overlay.innerHTML = state.blocks.map((b) => {
    const {x0, y0, x1, y1} = b.bbox;
    const style = `left:${x0 / W * 100}%;top:${y0 / H * 100}%;`
      + `width:${(x1 - x0) / W * 100}%;height:${(y1 - y0) / H * 100}%`;
    const cls = ['bk', 'bk-' + b.tier];
    if (b.id === state.selectedId) cls.push('sel');
    if (!shown.has(b.id)) cls.push('faded');
    if (b.dirty) cls.push('dirty');
    return `<div class="${cls.join(' ')}" data-id="${b.id}" style="${style}"`
      + ` title="${TIER_LABEL[b.tier]}"><i>${b.tier}</i></div>`;
  }).join('');
}

function renderBlockList() {
  el.blockCount.textContent = state.blocks.length ? String(state.blocks.length) : '—';
  el.filterBar.hidden = !state.blocks.length;

  if (!state.blocks.length) {
    el.blockList.innerHTML = state.sourceImage
      ? `<p class="placeholder">텍스트 블록을 찾지 못했습니다.<small>투명 배경 또는 단색 배경 위의 글자만 검출합니다.</small></p>`
      : `<p class="placeholder">이미지를 올리면 검출된 텍스트 블록이 여기에 표시됩니다.</p>`;
    return;
  }

  const list = visibleBlocks();
  if (!list.length) {
    el.blockList.innerHTML = '<p class="placeholder">조건에 맞는 블록이 없습니다.</p>';
    return;
  }

  el.blockList.innerHTML = list.map((b) => {
    const shown = typeof b.draft === 'string' ? b.draft : b.originalText;
    const mark = isUnsaved(b) ? '<span class="mark edit" title="저장하지 않은 변경">✎</span>'
      : b.dirty ? '<span class="mark done" title="저장됨">✓</span>' : '';
    const txt = shown
      ? escapeHtml(shown).replace(/\n/g, '<br>')
      : ('confidence' in b
        ? '<span class="fail">인식 실패</span>'
        : '<span class="pending">인식 대기…</span>');
    const low = typeof b.confidence === 'number' && b.originalText && b.confidence < CONF_LOW;
    const conf = typeof b.confidence === 'number' && b.originalText
      ? `<span class="conf${low ? ' low' : ''}" title="OCR 신뢰도">${Math.round(b.confidence)}%</span>` : '';
    const sel = b.id === state.selectedId ? ' sel' : '';
    return `<div class="item item-${b.tier}${b.locked ? ' locked' : ''}${low ? ' lowconf' : ''}${sel}"
                 data-id="${b.id}" role="button" tabindex="-1">
      <div class="item-head">
        <span class="badge badge-${b.tier}" title="${TIER_LABEL[b.tier]}">${b.locked ? '🔒 ' : ''}${b.tier}</span>
        ${mark}
        <span class="dim">${b.lines.length}줄 · ${b.bbox.x1 - b.bbox.x0}×${b.bbox.y1 - b.bbox.y0}</span>
        ${conf}
      </div>
      <div class="item-text">${txt}</div>
      ${low ? '<p class="hint">인식 신뢰도가 낮습니다. 문구를 확인해 주세요.</p>' : ''}
    </div>`;
  }).join('');
}

/* ---------------- 블록 선택·편집 (M3) ---------------- */

const byId = (id) => state.blocks.find((b) => b.id === id);
const isUnsaved = (b) => (b.draft ?? '') !== (b.editedText ?? '');
const visibleBlocks = () => state.blocks.filter((b) => {
  if (state.filter === 'editable') return !b.locked;
  if (state.filter === 'dirty') return b.dirty || isUnsaved(b);
  return true;
});

function selectBlock(id, {scroll = true} = {}) {
  state.selectedId = id;
  renderBlockList();
  renderEditor();
  if (scroll && id) {
    const node = el.blockList.querySelector(`.item[data-id="${id}"]`);
    if (node) node.scrollIntoView({block: 'nearest'});
  }
}

function renderEditor() {
  const b = byId(state.selectedId);
  if (!b) { el.editor.hidden = true; return; }
  el.editor.hidden = false;
  el.editorTitle.textContent = `블록 ${b.id} · ${TIER_LABEL[b.tier]}`;

  if (b.locked) {
    el.editorOrig.innerHTML = '<span class="locked-msg">배경이 복잡해 이번 버전에서는 교체할 수 없습니다.</span>';
    el.editorText.value = b.originalText || '';
    el.editorText.disabled = true;
    el.saveBtn.disabled = el.revertBtn.disabled = true;
    el.editorHint.textContent = '';
    return;
  }
  if (typeof b.draft !== 'string') {           // OCR 이 아직 끝나지 않은 블록
    el.editorOrig.innerHTML = '<span class="dim">인식 대기 중…</span>';
    el.editorText.value = '';
    el.editorText.disabled = true;
    el.saveBtn.disabled = el.revertBtn.disabled = true;
    el.editorHint.textContent = '';
    return;
  }

  el.editorOrig.innerHTML = b.originalText
    ? `원문 <code>${escapeHtml(b.originalText).replace(/\n/g, ' ⏎ ')}</code>`
    : '<span class="fail">원문 인식 실패 — 직접 입력하세요</span>';
  if (document.activeElement !== el.editorText) el.editorText.value = b.draft;
  el.editorText.disabled = false;
  el.editorText.rows = Math.max(2, b.lines.length + 1);
  el.saveBtn.disabled = !isUnsaved(b);
  el.revertBtn.disabled = !b.dirty && !isUnsaved(b);
  el.editorHint.textContent = isUnsaved(b) ? '저장하지 않은 변경'
    : b.dirty ? '저장됨' : '';
  el.editorHint.className = 'editor-hint' + (isUnsaved(b) ? ' warn' : b.dirty ? ' ok' : '');
}

function saveBlock() {
  const b = byId(state.selectedId);
  if (!b || b.locked) return;
  b.editedText = b.draft;
  b.dirty = b.editedText !== b.originalText;
  renderBlockList();
  renderEditor();
  renderDirtyCount();
  invalidateResult();
}

function revertBlock() {
  const b = byId(state.selectedId);
  if (!b || b.locked) return;
  b.draft = b.editedText = b.originalText;
  b.dirty = false;
  el.editorText.value = b.draft;
  renderBlockList();
  renderEditor();
  renderDirtyCount();
  invalidateResult();
}

/** 문구가 바뀌면 이전 합성 결과는 낡은 것이다. 원본 보기로 되돌린다. */
function invalidateResult() {
  if (!state.result) return;
  state.result = null;
  state.composeNotes = [];
  showResult(false);
  renderNotes();
}

function renderDirtyCount() {
  const n = state.blocks.filter((b) => b.dirty).length;
  const un = state.blocks.filter(isUnsaved).length;
  el.dirtyCount.textContent = n ? `수정된 블록 ${n}개${un ? ` (미저장 ${un})` : ''}` : '';
  el.composeBtn.disabled = !n || state.analyzing;
  el.composeBtn.title = n ? '' : '수정된 블록이 없습니다';
}

/* ---------------- 합성 (M4) ---------------- */

async function runCompose() {
  if (state.composing) return;
  state.composing = true;
  el.composeBtn.disabled = true;
  setStatus('합성 중…');
  await raf();
  try {
    const font = state.selectedFont || DEFAULT_FONT;
    const t0 = performance.now();
    const {canvas, notes} = await Compose.compose(state.imageData, state.blocks, font);
    state.result = canvas;
    state.composeNotes = notes;
    state.timing = {...(state.timing || {}), compose: Math.round(performance.now() - t0)};
    showResult(true);
    renderNotes();
    setStatus(null);
  } catch (e) {
    setStatus(`합성 실패: ${e.message}`, true);
    console.error(e);
  } finally {
    state.composing = false;
    renderDirtyCount();
  }
}

/** 미리보기를 원본/결과 사이에서 바꾼다. 오버레이는 결과 화면에서 숨긴다. */
function showResult(on) {
  if (on && !state.result) return;
  state.showing = on ? 'result' : 'original';
  const ctx = el.canvas.getContext('2d');
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  if (on) ctx.drawImage(state.result, 0, 0);
  else ctx.putImageData(state.imageData, 0, 0);
  el.overlay.style.display = on ? 'none' : '';
  el.toggleBtn.disabled = !state.result;
  el.toggleBtn.textContent = on ? '원본 보기' : '결과 보기';
  el.downloadBtn.disabled = true;   // 다운로드는 M6
}

function renderNotes() {
  const ns = state.composeNotes;
  if (!ns.length) { el.notes.hidden = true; return; }
  el.notes.hidden = false;
  el.notes.innerHTML = ns.map((n) =>
    `<span class="note note-${n.level}">${escapeHtml(n.id)} · ${escapeHtml(n.text)}</span>`).join('');
}

/** 방향키로 블록을 옮겨 다닌다. 블록이 많을 때 목록 클릭만으로는 답답하다. */
function moveSelection(delta) {
  const list = visibleBlocks();
  if (!list.length) return;
  const i = list.findIndex((b) => b.id === state.selectedId);
  const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta));
  selectBlock(list[next].id);
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

function highlight(id) {
  el.overlay.querySelectorAll('.bk').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
  el.blockList.querySelectorAll('.item').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
}

function reset() {
  Object.assign(state, {
    fileName: null, sourceImage: null, imageData: null, stats: null,
    blocks: [], selectedId: null, analyzing: false, filter: 'all',
    result: null, showing: 'original', composeNotes: [],
  });
  el.notes.hidden = true;
  el.overlay.style.display = '';
  el.toggleBtn.disabled = true;
  el.toggleBtn.textContent = '원본 / 결과';
  el.editor.hidden = true;
  el.filterBar.hidden = true;
  el.dirtyCount.textContent = '';
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

// 목록 ↔ 오버레이 상호 강조. 선택된 블록이 있으면 그쪽 강조를 유지한다.
const hoverOff = () => highlight(state.selectedId);
el.blockList.addEventListener('mouseover', (e) => {
  const it = e.target.closest('.item');
  if (it) highlight(it.dataset.id);
});
el.blockList.addEventListener('mouseleave', hoverOff);
el.overlay.addEventListener('mouseover', (e) => {
  const bk = e.target.closest('.bk');
  if (bk) highlight(bk.dataset.id);
});
el.overlay.addEventListener('mouseleave', hoverOff);

/* ---------------- 선택·편집 (M3) ---------------- */

el.blockList.addEventListener('click', (e) => {
  const it = e.target.closest('.item');
  if (it) selectBlock(it.dataset.id, {scroll: false});
});
el.overlay.addEventListener('click', (e) => {
  const bk = e.target.closest('.bk');
  if (bk) selectBlock(bk.dataset.id);          // 목록 쪽으로 스크롤해 준다
});
el.editorClose.addEventListener('click', () => selectBlock(null));

el.editorText.addEventListener('input', () => {
  const b = byId(state.selectedId);
  if (!b || b.locked) return;
  b.draft = el.editorText.value;
  renderBlockList();
  el.saveBtn.disabled = !isUnsaved(b);
  el.revertBtn.disabled = !b.dirty && !isUnsaved(b);
  el.editorHint.textContent = isUnsaved(b) ? '저장하지 않은 변경' : b.dirty ? '저장됨' : '';
  el.editorHint.className = 'editor-hint' + (isUnsaved(b) ? ' warn' : b.dirty ? ' ok' : '');
  renderDirtyCount();
});
el.editorText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBlock(); }
  if (e.key === 'Escape') { e.preventDefault(); el.editorText.blur(); }
});
el.composeBtn.addEventListener('click', runCompose);
el.toggleBtn.addEventListener('click', () => showResult(state.showing !== 'result'));
el.saveBtn.addEventListener('click', saveBlock);
el.revertBtn.addEventListener('click', revertBlock);

el.filterBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  [...el.filterBar.children].forEach((b) => b.classList.toggle('on', b === btn));
  renderBlockList();
  renderOverlay();
});

// 방향키 이동. 입력 중일 때는 가로채지 않는다.
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (!state.blocks.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter' && state.selectedId) {
    e.preventDefault();
    if (!el.editorText.disabled) el.editorText.focus();
  } else if (e.key === 'Escape') {
    selectBlock(null);
  }
});

window.__app = {state, loadFile, runAnalysis, selectBlock, saveBlock, revertBlock,
                runCompose, showResult};
