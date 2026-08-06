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
  revertAllBtn: $('revertAllBtn'), fileName: $('fileName'),
  viewToggle: $('viewToggle'), typoPanel: $('typoPanel'),
  typoWrap: $('typoWrap'), typoTotalMini: $('typoTotalMini'), verdict: $('verdict'),
  stage: $('stage'), dropzone: $('dropzone'), viewport: $('viewport'),
  canvas: $('preview'), overlay: $('overlay'), bgToggle: $('bgToggle'),
  info: $('imgInfo'), blockCount: $('blockCount'), blockList: $('blockList'),
  status: $('status'), filterBar: $('filterBar'),
  editor: $('editor'), editorTitle: $('editorTitle'), editorOrig: $('editorOrig'),
  editorText: $('editorText'), editorHint: $('editorHint'), editorClose: $('editorClose'),
  saveBtn: $('saveBtn'), revertBtn: $('revertBtn'),
  dirtyCount: $('dirtyCount'), regionsBtn: $('regionsBtn'),
  downloadBtn: $('downloadBtn'), notes: $('notes'),
  fontSelect: $('fontSelect'),
  localFontBtn: $('localFontBtn'), lfPanel: $('lfPanel'), lfBackdrop: $('lfBackdrop'),
  lfClose: $('lfClose'), lfAdded: $('lfAdded'), lfName: $('lfName'), lfAdd: $('lfAdd'),
  lfMsg: $('lfMsg'), lfScan: $('lfScan'), lfFilter: $('lfFilter'), lfList: $('lfList'),
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
  result: null,          // 합성 결과 canvas
  showing: 'original',   // 'original' | 'result'
  composeNotes: [],
  showAllRegions: true,  // 영역 표시 토글
  fontMode: 'auto',
  selectedFont: null,
  analyzing: false,
};

const ALPHA_T = 20;
const TIER_LABEL = {A: '투명 배경', B: '단색 배경', C: '편집 불가'};
// 실측상 인식에 성공한 블록은 86~96%, 실패한 블록은 0~79% 였다.
// 신뢰도가 성공/실패를 꽤 잘 가르므로 낮은 블록을 눈에 띄게 표시한다.
const CONF_LOW = 70;
// 자동판별이 실패한 블록에 쓰는 최후 수단.
const DEFAULT_FONT = {family: 'Pretendard', weight: 400};

/** 블록에 쓸 폰트. 직접 선택이면 전 블록에 같은 폰트를 쓴다. */
function fontFor(b) {
  if (state.fontMode === 'manual' && state.selectedFont) return state.selectedFont;
  return b.detectedFont || DEFAULT_FONT;
}

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
  // 이전 이미지의 합성 결과가 남아 있으면 다운로드 버튼이 옛 그림을 내보낸다.
  state.result = null;
  state.showing = 'original';
  state.composeNotes = [];

  el.dropzone.hidden = true;
  el.viewport.hidden = false;
  el.notes.hidden = true;
  el.editor.hidden = true;
  el.downloadBtn.disabled = true;
  renderViewToggle();
  typoCache.clear();
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

    const t2 = performance.now();
    await FontMatch.detectAll(state.imageData, state.blocks, (i, n) => {
      setStatus(`폰트 판별 중… ${i + 1} / ${n}`);
    });
    state.timing.font = Math.round(performance.now() - t2);

    // 정렬은 이미지 전체를 봐야 정해진다. 왼쪽에 붙은 이웃이 있는지, 이미지
    // 한가운데인지는 블록 하나만 봐서는 알 수 없다. 한 번 정해 블록에 박아 두면
    // 합성·판별·계측이 모두 같은 값을 쓴다.
    for (const b of state.blocks) {
      b.align = Compose.util.guessAlign(b, state.blocks, state.imageData.width);
    }
    typoCache.clear();
    renderBlockList();
    renderEditor();
    el.fontSelect.disabled = false;
    el.regionsBtn.disabled = false;
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
  if (!file || !state.stats) {
    el.info.innerHTML = '<div><dt>이미지</dt><dd class="dim">아직 없음</dd></div>';
    return;
  }
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
}

/** 블록 경계를 이미지 위에 겹쳐 그린다.
 *  캔버스는 CSS로만 축소되므로 % 좌표를 쓰면 확대/축소와 무관하게 맞는다. */
function renderOverlay() {
  // 상자는 **항상** 만든다. '영역 표시'를 끄면 안 보이게만 하고 클릭은 살려 둔다.
  // 예전에는 아예 안 그려서, 표시를 끄면 미리보기에서 블록을 고를 수 없었다.
  // 보이는 것과 고를 수 있는 것은 다른 문제다.
  const W = el.canvas.width, H = el.canvas.height;
  const shown = new Set(visibleBlocks().map((b) => b.id));
  el.overlay.innerHTML = state.blocks.map((b) => {
    const {x0, y0, x1, y1} = b.bbox;
    const style = `left:${x0 / W * 100}%;top:${y0 / H * 100}%;`
      + `width:${(x1 - x0) / W * 100}%;height:${(y1 - y0) / H * 100}%`;
    const cls = ['bk', 'bk-' + b.tier];
    if (b.id === state.selectedId) cls.push('sel');
    else if (!state.showAllRegions) cls.push('ghost');
    if (!shown.has(b.id)) cls.push('faded');
    if (b.dirty) cls.push('dirty');
    // 미리보기 위 라벨은 목록·편집창이 쓰는 이름과 같아야 한다. 유형 문자(A/B/C)는
    // 내부 용어라 화면에 그대로 내보내지 않는다.
    return `<div class="${cls.join(' ')}" data-id="${b.id}" style="${style}"`
      + ` title="${TIER_LABEL[b.tier]}"><i>${b.id}</i></div>`;
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
    const mark = isUnsaved(b) ? '<span class="mark edit" title="저장하지 않은 변경">✎ 미저장</span>'
      : b.dirty ? '<span class="mark done" title="저장됨">✓ 수정됨</span>' : '';
    const txt = shown
      ? escapeHtml(shown).replace(/\n/g, '<br>')
      : ('confidence' in b
        ? '<span class="fail">글자를 읽지 못했습니다</span>'
        : '<span class="pending">읽는 중…</span>');
    const low = typeof b.confidence === 'number' && b.originalText && b.confidence < CONF_LOW;
    const conf = typeof b.confidence === 'number' && b.originalText
      ? `<span class="conf${low ? ' low' : ''}" title="글자를 얼마나 확실하게 읽었는지">글자 인식 ${Math.round(b.confidence)}%</span>` : '';
    const sf = safety(b);
    const sel = b.id === state.selectedId ? ' sel' : '';
    return `<div class="item item-${b.tier}${b.locked ? ' locked' : ''}${low ? ' lowconf' : ''}${sel}"
                 data-id="${b.id}" role="button" tabindex="-1"
                 title="${TIER_LABEL[b.tier]}">
      <div class="item-head">
        <span class="chip ${sf.cls}">${sf.label}</span>
        ${mark}
        <span class="spacer"></span>
        ${conf}
      </div>
      <div class="item-text">${txt}</div>
      ${fontLine(b)}
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
  renderOverlay();      // '영역 표시'를 끈 상태에서는 선택이 곧 표시 대상이다
  if (scroll && id) {
    const node = el.blockList.querySelector(`.item[data-id="${id}"]`);
    if (node) node.scrollIntoView({block: 'nearest'});
  }
}

function renderEditor() {
  const b = byId(state.selectedId);
  renderTypoPanel(b);
  if (!b) { el.editor.hidden = true; el.verdict.hidden = true; return; }
  el.editor.hidden = false;

  // 판정을 제목 옆이 아니라 제목 줄 자체에 붙인다. 담당자가 블록을 고르면
  // 제일 먼저 읽어야 하는 것이 "바꿔도 되나"다.
  const sf = safety(b);
  el.editorTitle.innerHTML = `<span class="chip ${sf.cls}">${sf.label}</span>`
    + ` <span class="dim">블록 ${b.id} · ${TIER_LABEL[b.tier]}</span>`;
  el.verdict.hidden = !sf.text;
  el.verdict.className = `verdict ${sf.cls}`;
  el.verdict.textContent = sf.text;

  if (b.locked) {
    el.editorOrig.innerHTML = '';
    el.editorText.value = b.originalText || '';
    el.editorText.disabled = true;
    el.saveBtn.disabled = el.revertBtn.disabled = true;
    el.editorHint.textContent = '';
    return;
  }
  if (typeof b.draft !== 'string') {           // OCR 이 아직 끝나지 않은 블록
    el.editorOrig.innerHTML = '<span class="dim">글자를 읽는 중…</span>';
    el.editorText.value = '';
    el.editorText.disabled = true;
    el.saveBtn.disabled = el.revertBtn.disabled = true;
    el.editorHint.textContent = '';
    return;
  }

  el.editorOrig.innerHTML = b.originalText
    ? `<span class="dim">원래 문구</span> <code>${escapeHtml(b.originalText).replace(/\n/g, ' ⏎ ')}</code>`
    : '<span class="fail">글자를 읽지 못했습니다 — 직접 입력하세요</span>';
  if (document.activeElement !== el.editorText) el.editorText.value = b.draft;
  el.editorText.disabled = false;
  // 줄 수에 맞추되 화면을 잡아먹지 않게 4줄에서 자른다. 더 필요하면 사용자가
  // 모서리를 끌어 늘릴 수 있다(resize: vertical).
  el.editorText.rows = Math.min(4, Math.max(2, b.lines.length + 1));
  el.saveBtn.disabled = !isUnsaved(b);
  el.revertBtn.disabled = !b.dirty && !isUnsaved(b);
  el.editorHint.textContent = isUnsaved(b) ? '저장하지 않았습니다'
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
  return refreshResult();     // 저장이 곧 결과 보기다
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
  return refreshResult();
}

function renderDirtyCount() {
  const n = state.blocks.filter((b) => b.dirty).length;
  const un = state.blocks.filter(isUnsaved).length;
  el.dirtyCount.textContent = n ? `수정 ${n}개${un ? ` · 미저장 ${un}` : ''}` : '';
  el.revertAllBtn.disabled = !n && !un;
  el.revertAllBtn.textContent = n || un ? `수정 초기화 (${n + un})` : '수정 초기화';
}

/** 모든 블록을 원문으로 되돌린다. 파일은 그대로 둔다. */
async function revertAll() {
  const targets = state.blocks.filter((b) => b.dirty || isUnsaved(b));
  if (!targets.length) return;
  if (!confirm(`수정한 ${targets.length}개 블록을 전부 원래 문구로 되돌립니다.`)) return;
  for (const b of targets) {
    b.draft = b.originalText;
    b.editedText = b.originalText;
    b.dirty = false;
  }
  renderBlockList();
  renderEditor();
  renderDirtyCount();
  await refreshResult();
}

/**
 * 결과를 현재 편집 상태로 다시 만든다.
 * 수정된 블록이 하나도 없으면 결과라는 게 없으므로 원본으로 돌아간다.
 */
async function refreshResult() {
  if (!state.blocks.some((b) => b.dirty)) {
    state.result = null;
    state.composeNotes = [];
    renderNotes();
    showResult(false, {keepSelection: true});
    return;
  }
  await runCompose();
}

/* ---------------- 합성 (M4) ---------------- */

async function runCompose() {
  if (state.composing) return;
  state.composing = true;
  setStatus('반영 중…');
  await raf();
  try {
    const t0 = performance.now();
    const {canvas, notes} = await Compose.compose(state.imageData, state.blocks, fontFor);
    state.result = canvas;
    state.composeNotes = notes;
    state.timing = {...(state.timing || {}), compose: Math.round(performance.now() - t0)};
    showResult(true, {keepSelection: true});
    renderNotes();
    setStatus(null);
  } catch (e) {
    setStatus(`반영 실패: ${e.message}`, true);
    console.error(e);
  } finally {
    state.composing = false;
    renderDirtyCount();
  }
}

/**
 * 미리보기를 원본/결과 사이에서 바꾼다.
 *
 * 전환은 곧 '비교하겠다'는 뜻이다. 선택된 블록의 테두리가 남아 있으면 정작
 * 글자를 못 보므로 선택을 푼다.
 */
function showResult(on, {keepSelection = false} = {}) {
  if (on && !state.result) return;
  if (!keepSelection && state.selectedId) {
    state.selectedId = null;
    renderBlockList();
    renderEditor();
  }
  state.showing = on ? 'result' : 'original';
  const ctx = el.canvas.getContext('2d');
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  if (on) ctx.drawImage(state.result, 0, 0);
  else ctx.putImageData(state.imageData, 0, 0);
  renderViewToggle();
  el.downloadBtn.disabled = !state.result;
  renderOverlay();
}

function renderViewToggle() {
  for (const btn of el.viewToggle.children) {
    const isResult = btn.dataset.view === 'result';
    btn.classList.toggle('on', isResult === (state.showing === 'result'));
    btn.disabled = isResult && !state.result;
  }
}

/* ---------------- 다운로드 (M6) ---------------- */

/** 결과를 PNG로 저장한다.
 *  원본이 JPG여도 PNG로 내보낸다. 재압축 열화를 피하고 투명도를 보존하기 위함이다. */
function download() {
  if (!state.result) return;
  state.result.toBlob((blob) => {
    if (!blob) { setStatus('저장에 실패했습니다.', true); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outputName(state.fileName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 브라우저가 저장을 시작할 시간을 준 뒤 해제한다.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'image/png');
}

const outputName = (name) =>
  (name || 'image').replace(/\.[^.]+$/, '') + '-edited.png';

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

/** 목록에 보여줄 폰트 한 줄. 직접 선택 모드면 그 폰트를, 아니면 판별 결과를 쓴다. */
/* ---------------- 타이포 계측 표시 ---------------- */

// 블록마다 계측 결과를 캐시한다. 폰트가 바뀌면 버린다 — 폰트가 바뀌면 크기·자간·
// 정렬이 전부 다시 잡히므로 이전 수치는 의미가 없다.
const typoCache = new Map();
const typoKey = (b) => `${b.id}|${FontMatch.label(fontFor(b))}`;

function typoFor(b) {
  if (!state.imageData || !b.originalText || b.locked) return null;
  const key = typoKey(b);
  if (typoCache.has(key)) return typoCache.get(key);
  let m = null;
  try { m = Typo.measure(state.imageData, b, fontFor(b)); }
  catch (e) { console.error(e); }
  typoCache.set(key, m);
  return m;
}

const pct = (v) => Math.round(v * 100);

/**
 * 점수대별 색. 눈으로 훑을 때 숫자를 읽지 않고도 걸러지게 한다.
 *
 * 기준을 항목마다 다르게 둔다. 실루엣 IoU 는 정답 폰트를 써도 80%를 넘기 어렵고
 * (실측 중앙값 47%), 크기·자간·정렬은 맞으면 100%가 나온다. 같은 잣대를 대면
 * 폰트는 늘 빨갛고 나머지는 늘 초록이라 색이 아무 정보도 주지 않는다.
 */
const BANDS = {
  font: [0.65, 0.40], total: [0.85, 0.70], fit: [0.95, 0.85],
};
const scoreClass = (v, kind = 'fit') => {
  const [g, o] = BANDS[kind] || BANDS.fit;
  return v >= g ? 'good' : v >= o ? 'ok' : 'bad';
};

/** 목록용 한 줄 요약 — 글꼴·크기·간격을 한눈에. */
function fontLine(b) {
  const m = typoFor(b);
  if (!m) {
    const f = (state.fontMode === 'manual' && state.selectedFont) || b.detectedFont;
    return f ? `<p class="fontinfo"><span class="fi-k">글꼴</span> ${escapeHtml(FontMatch.label(f))}</p>` : '';
  }
  const manual = state.fontMode === 'manual' && state.selectedFont;
  return `<p class="fontinfo">
    <span class="fi-k">글꼴</span> ${escapeHtml(m.font.label)}${manual ? ' <span class="fi-k">직접 고름</span>' : ''}
    <span class="fi-k">크기</span> ${m.size.px.toFixed(0)}px
    <span class="fi-k">자간</span> ${fmtTrack(m.tracking)}
    ${m.leading ? `<span class="fi-k">행간</span> ${m.leading.px}px` : ''}
  </p>`;
}

const fmtTrack = (t) => `${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(1)}%`;

/** 상세 계측 패널 — 피그마의 타이포 속성처럼 항목별로 나눠 보여 준다. */
/**
 * "이 블록을 바꿔도 되나" — 한 단어로 답한다.
 *
 * 담당자가 목록을 훑을 때 필요한 건 백분율이 아니라 이 판정이다. 숫자는 근거라
 * 뒤로 뺀다. 판정 기준은 계측 항목 중 **고칠 수 없는 것**을 먼저 본다:
 * 자리·크기·간격이 어긋나면 어떤 폰트를 골라도 티가 난다.
 */
function safety(b) {
  if (b.locked) {
    return {key: 'locked', label: '편집 불가', cls: 'bad',
            text: '배경이 복잡해 이 블록은 바꿀 수 없습니다.'};
  }
  const m = typoFor(b);
  if (!m) return {key: 'wait', label: '대기', cls: 'dimchip', text: ''};

  const off = [];
  if (m.tracking.capped || m.tracking.score < 0.9) off.push('글자 폭');
  if (m.align.score < 0.95) off.push('가로 위치');
  if (m.size.score < 0.9) off.push('글자 크기');
  if (off.length) {
    return {key: 'risk', label: '위험', cls: 'bad', m,
            text: `${off.join('·')}이(가) 원본과 어긋납니다. 바꾸면 티가 납니다.`};
  }

  const drift = m.align.drift >= 0.05
    ? ` 다만 ${m.align.label} 정렬이라 문구 길이가 바뀌면 좌우로 ${m.align.drift.toFixed(1)}px 움직입니다.`
    : '';
  const lowConf = typeof b.confidence === 'number' && b.originalText && b.confidence < CONF_LOW;
  if (lowConf) {
    return {key: 'check', label: '문구 확인', cls: 'ok', m,
            text: `자리·크기·간격은 맞습니다. 다만 읽어낸 문구가 틀렸을 수 있으니 원문과 대조해 주세요.${drift}`};
  }
  if (m.font.score < BANDS.font[1]) {
    return {key: 'careful', label: '글꼴 다름', cls: 'ok', m,
            text: `자리·크기·간격은 맞지만 글꼴 모양이 원본과 꽤 다릅니다.${drift}`};
  }
  return {key: 'safe', label: '안전', cls: 'good', m,
          text: `그대로 바꿔도 됩니다. 자리·크기·간격이 원본과 맞습니다.${drift}`};
}

/* 전문 용어를 쓰지 않는다. 담당자는 디자이너가 아니다.
 * 다만 디자인팀과 이야기할 때 쓰는 말(자간·행간)은 괄호로 같이 둔다. */
const TYPO_LABEL = {
  font: '글꼴', size: '글자 크기', tracking: '글자 사이 (자간)',
  leading: '줄 사이 (행간)', align: '가로 위치',
};

function renderTypoPanel(b) {
  const m = b && !b.locked ? typoFor(b) : null;
  el.typoWrap.hidden = !m;
  if (!m) return;

  const row = (key, value, score, note, kind) => `
    <div class="typo-row">
      <span class="typo-k">${key}</span>
      <span class="typo-v">${value}</span>
      ${score === null
        ? `<span class="typo-bar"></span><span class="typo-s dim">${note || '—'}</span>`
        : `<span class="typo-bar"><i class="${scoreClass(score, kind)}" style="width:${pct(score)}%"></i></span>
           <span class="typo-s ${scoreClass(score, kind)}">${pct(score)}%</span>`}
    </div>`;

  const d = b.detectedFont;
  const fontNote = state.fontMode === 'manual' && state.selectedFont ? '직접 고름'
    : d && d.adjusted ? '이미지 기준으로 맞춤'
    : d && d.lowConfidence ? '비슷한 후보가 많음' : '';

  el.typoTotalMini.className = `tscore ${scoreClass(m.total, 'total')}`;
  el.typoTotalMini.textContent = `${pct(m.total)}%`;

  el.typoPanel.innerHTML = `
    ${row(TYPO_LABEL.font, escapeHtml(m.font.label)
        + (fontNote ? ` <span class="lowgap">${fontNote}</span>` : ''), m.font.score, null, 'font')}
    ${row(TYPO_LABEL.size, `${m.size.px.toFixed(1)} px`, m.size.score)}
    ${row(TYPO_LABEL.tracking, `${fmtTrack(m.tracking)} <span class="dim">(${m.tracking.px.toFixed(2)}px)</span>`
        + (m.tracking.capped ? ' <span class="lowgap">더 못 좁힘</span>' : ''), m.tracking.score)}
    ${m.leading
      ? row(TYPO_LABEL.leading, `${m.leading.px} px <span class="dim">(글자 크기의 ${m.leading.ratio.toFixed(2)}배`
          + `, 글꼴 기본보다 ${m.leading.delta >= 0 ? '넓음 +' : '좁음 '}${m.leading.delta.toFixed(0)}%)</span>`,
          null, '원본 그대로')
      : row(TYPO_LABEL.leading, '<span class="dim">한 줄이라 잴 것이 없음</span>', null, '—')}
    ${row(TYPO_LABEL.align, `${m.align.label} <span class="dim">· ${m.align.drift < 0.05
        ? '문구가 바뀌어도 제자리'
        : `한 글자 줄면 ${m.align.drift.toFixed(1)}px 움직임`}</span>`, m.align.score)}
    <p class="typo-note">전부 <b>원문을 다시 그려 원본과 겹쳐 본</b> 결과입니다.
      원문조차 제자리에 못 놓으면 바꾼 문구는 더 어긋납니다.</p>`;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

function highlight(id) {
  el.overlay.querySelectorAll('.bk').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
  el.blockList.querySelectorAll('.item').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
}

/* ---------------- 이벤트 ---------------- */

const openPicker = () => el.fileInput.click();
el.pickBtn.addEventListener('click', openPicker);
el.pickBtn2.addEventListener('click', openPicker);
el.revertAllBtn.addEventListener('click', revertAll);
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

// 같은 블록을 다시 누르면 선택을 푼다. 체크를 해제하듯 되돌릴 수단이 있어야 한다.
const toggleSelect = (id, opts) => selectBlock(id === state.selectedId ? null : id, opts);

el.blockList.addEventListener('click', (e) => {
  const it = e.target.closest('.item');
  if (it) toggleSelect(it.dataset.id, {scroll: false});
});
el.overlay.addEventListener('click', (e) => {
  const bk = e.target.closest('.bk');
  if (bk) toggleSelect(bk.dataset.id);         // 목록 쪽으로 스크롤해 준다
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
/* ---------------- 폰트 (M5) ---------------- */

// 자동판별과 직접 선택을 드롭다운 하나로 합쳤다. 라디오 + 드롭다운 두 컨트롤이
// 같은 것을 정하고 있어 상단에 둘 이유가 없었다.
// 드롭다운에는 자동판별 후보가 아닌 폰트도 넣는다. 자동판별을 좁힌 것과
// 사용자가 고를 수 있는 폭을 좁히는 것은 다른 문제다.
// 목록은 로컬 폰트를 등록/해제할 때마다 다시 그린다. 고르고 있던 항목은
// 인덱스가 아니라 이름으로 되찾는다 — 목록이 바뀌면 인덱스는 의미가 없다.
let fontOptions = [];
function renderFontOptions() {
  const keep = state.selectedFont ? FontMatch.label(state.selectedFont) : null;
  fontOptions = FontMatch.all();
  el.fontSelect.innerHTML = '<option value="auto">자동판별</option>'
    + fontOptions.map((f, i) => `<option value="${i}">${escapeHtml(FontMatch.label(f))}`
      + `${f.excluded ? ' (판별 제외)' : ''}</option>`).join('');

  if (keep) {
    const i = fontOptions.findIndex((f) => FontMatch.label(f) === keep);
    if (i >= 0) { el.fontSelect.value = String(i); state.selectedFont = fontOptions[i]; return; }
    // 고르고 있던 로컬 폰트를 방금 뺐다면 자동판별로 되돌린다.
    state.fontMode = 'auto';
    state.selectedFont = null;
  }
  el.fontSelect.value = 'auto';
}
renderFontOptions();

el.fontSelect.addEventListener('change', async () => {
  const v = el.fontSelect.value;
  state.fontMode = v === 'auto' ? 'auto' : 'manual';
  state.selectedFont = v === 'auto' ? null : fontOptions[+v];
  typoCache.clear();
  renderBlockList();
  renderEditor();
  await refreshResult();
});

/* ---------------- 내 PC 폰트 ---------------- */

/** 등록 목록이 바뀌면 후보·드롭다운을 갱신하고, 필요하면 다시 판별한다. */
async function applyLocalFonts({redetect} = {}) {
  FontMatch.setLocal(LocalFont.list());
  renderFontOptions();
  renderLocalAdded();
  if (!redetect || !state.imageData || !state.blocks.length || state.analyzing) return;
  state.analyzing = true;
  try {
    setStatus('폰트 다시 판별 중…');
    await FontMatch.detectAll(state.imageData, state.blocks, (i, n) => {
      setStatus(`폰트 다시 판별 중… ${i + 1} / ${n}`);
    });
    setStatus(null);
  } finally {
    state.analyzing = false;
  }
  typoCache.clear();
  renderBlockList();
  renderEditor();
  await refreshResult();
}

function renderLocalAdded() {
  const fonts = LocalFont.list();
  el.lfAdded.innerHTML = fonts.length
    ? fonts.map((f) => `<span class="lf-chip">${escapeHtml(f.name)}`
        + `<button type="button" data-ps="${escapeHtml(f.ps)}" aria-label="제거">✕</button></span>`).join('')
    : '<p class="dim">아직 없습니다. 아래에서 추가하세요.</p>';
}

function lfMsg(text, isError = false) {
  el.lfMsg.hidden = !text;
  el.lfMsg.textContent = text || '';
  el.lfMsg.classList.toggle('err', isError);
}

function openLocalFonts() {
  renderLocalAdded();
  lfMsg(null);
  el.lfPanel.hidden = false;
  el.lfBackdrop.hidden = false;
  el.lfName.focus();
}
function closeLocalFonts() {
  el.lfPanel.hidden = true;
  el.lfBackdrop.hidden = true;
}

el.localFontBtn.addEventListener('click', openLocalFonts);
el.lfClose.addEventListener('click', closeLocalFonts);
el.lfBackdrop.addEventListener('click', closeLocalFonts);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.lfPanel.hidden) closeLocalFonts();
});

async function addLocalFont(ps, name, group) {
  try {
    await LocalFont.add(ps, name, group);
    lfMsg(`"${name || ps}" 을(를) 후보에 넣었습니다.`);
    await applyLocalFonts({redetect: true});
    return true;
  } catch (e) {
    lfMsg(e.message, true);
    return false;
  }
}

el.lfAdd.addEventListener('click', async () => {
  const v = el.lfName.value.trim();
  if (!v) return;
  if (await addLocalFont(v)) el.lfName.value = '';
});
el.lfName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.lfAdd.click(); }
});

el.lfAdded.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-ps]');
  if (!btn) return;
  LocalFont.remove(btn.dataset.ps);
  lfMsg(null);
  await applyLocalFonts({redetect: true});
});

// 열거 결과는 수백 개가 나온다. 검색으로 좁혀야 쓸 수 있다.
let lfScanned = [];
function renderLocalList() {
  const q = el.lfFilter.value.trim().toLowerCase();
  const hit = (q ? lfScanned.filter((f) => f.name.toLowerCase().includes(q)
    || f.family.toLowerCase().includes(q) || f.ps.toLowerCase().includes(q)) : lfScanned).slice(0, 300);
  el.lfList.innerHTML = hit.length
    ? hit.map((f) => `<button type="button" class="lf-item${LocalFont.has(f.ps) ? ' on' : ''}"`
        + ` data-ps="${escapeHtml(f.ps)}" data-name="${escapeHtml(f.name)}"`
        + ` data-family="${escapeHtml(f.family)}">${escapeHtml(f.name)}</button>`).join('')
    : '<p class="dim">검색 결과가 없습니다.</p>';
}

el.lfScan.addEventListener('click', async () => {
  try {
    lfScanned = await LocalFont.enumerate();
    if (!lfScanned.length) {
      lfMsg('설치된 폰트를 하나도 읽지 못했습니다. 아래에 이름을 직접 적어 넣으세요.', true);
      el.lfName.focus();
      return;
    }
    el.lfFilter.hidden = false;
    el.lfList.hidden = false;
    lfMsg(`설치된 폰트 ${lfScanned.length}개. 검색해서 고르세요.`);
    renderLocalList();
  } catch (e) {
    lfMsg(e.message, true);
    el.lfName.focus();
  }
});
el.lfFilter.addEventListener('input', renderLocalList);
el.lfList.addEventListener('click', async (e) => {
  const it = e.target.closest('.lf-item');
  if (!it) return;
  const {ps, name, family} = it.dataset;
  if (LocalFont.has(ps)) { LocalFont.remove(ps); await applyLocalFonts({redetect: true}); }
  else await addLocalFont(ps, name, family);
  renderLocalList();
});

// 지난번에 고른 폰트를 다시 등록한다. 권한이 필요 없는 경로라 조용히 된다.
LocalFont.restore().then(({ok}) => { if (ok) applyLocalFonts(); });

el.regionsBtn.addEventListener('click', () => {
  state.showAllRegions = !state.showAllRegions;
  el.regionsBtn.classList.toggle('on', state.showAllRegions);
  renderOverlay();
});

// 버튼으로 전환할 때만 선택을 푼다. 내부 갱신은 편집 맥락을 유지해야 한다.
el.viewToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn || btn.disabled) return;
  showResult(btn.dataset.view === 'result');
});
el.downloadBtn.addEventListener('click', download);
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
                runCompose, showResult, fontFor, download, outputName};
