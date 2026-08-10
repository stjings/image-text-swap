/* 블록 선택·편집·저장(M3) 동작 검증 도구. 배포물이 아니다.
 *   NODE_PATH=$(npm root -g) node tools/edit-probe.js
 *
 * 실제 UI를 조작해 상태 전이를 확인한다. 화면이 뜨는지가 아니라
 * "고치고 저장한 것이 합성 입력으로 남는가"를 본다.
 */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 8935;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 980}});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-complex.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});

  const snap = () => page.evaluate(() => {
    const s = window.__app.state;
    const b = s.blocks.find((x) => x.id === s.selectedId);
    return {
      selected: s.selectedId, filter: s.filter,
      editorHidden: document.getElementById('editor').hidden,
      shownItems: document.querySelectorAll('#blockList .item').length,
      dirtyCount: document.getElementById('dirtyCount').textContent,
      saveDisabled: document.getElementById('saveBtn').disabled,
      block: b ? {draft: b.draft, edited: b.editedText, orig: b.originalText, dirty: b.dirty, locked: b.locked} : null,
    };
  });

  // 블록 ID 는 검출 결과에 따라 달라진다. 실행 시점에 조건으로 고른다.
  const TARGET = await page.evaluate(() =>
    (window.__app.state.blocks.find((b) => !b.locked && /이벤트 기간/.test(b.originalText || ''))
      || window.__app.state.blocks.find((b) => !b.locked)).id);
  const THIRD = await page.evaluate(() =>
    document.querySelectorAll('#blockList .item')[2].dataset.id);

  console.log('\n[선택]');
  await page.click('#blockList .item:nth-child(3)');
  let s = await snap();
  check('목록 클릭으로 선택된다', s.selected === THIRD, s.selected);
  check('편집 패널이 열린다', s.editorHidden === false);

  await page.click(`.bk[data-id="${TARGET}"]`);
  s = await snap();
  check('오버레이 클릭으로도 선택된다', s.selected === TARGET, s.selected);

  console.log('\n[편집·저장]');
  const before = s.block.orig;
  await page.fill('#editorText', '바뀐 문구');
  s = await snap();
  check('입력이 draft 에 반영된다', s.block.draft === '바뀐 문구');
  check('아직 확정되지 않았다', s.block.edited === before && s.block.dirty === false);
  check('저장 버튼이 활성화된다', s.saveDisabled === false);
  check('미저장 표시가 뜬다', /미저장 1/.test(s.dirtyCount) === false && s.dirtyCount === '',
    `dirtyCount="${s.dirtyCount}"`);

  await page.click('#saveBtn');
  s = await snap();
  check('저장하면 확정된다', s.block.edited === '바뀐 문구');
  check('dirty 로 표시된다', s.block.dirty === true);
  check('하단에 수정 개수가 나온다', /수정 1개/.test(s.dirtyCount), s.dirtyCount);
  check('저장 후 버튼이 비활성화된다', s.saveDisabled === true);

  console.log('\n[필터]');
  const total = (await snap()).shownItems;
  await page.click('#filterBar button[data-filter="dirty"]');
  s = await snap();
  check('수정됨 필터가 1개만 남긴다', s.shownItems === 1, `${s.shownItems}/${total}`);
  await page.click('#filterBar button[data-filter="editable"]');
  s = await snap();
  // 고칠 게 아닌 것은 다 빠져야 한다 — 잠긴 블록과 '그림으로 보이는' 블록.
  const out = await page.evaluate(() => window.__app.state.blocks
    .filter((b) => b.locked || window.__app.looksNotText(b)).length);
  check('편집 가능 필터가 잠긴 블록·그림 블록을 뺀다', s.shownItems === total - out,
    `${s.shownItems} = ${total} - ${out}`);
  await page.click('#filterBar button[data-filter="all"]');

  console.log('\n[선택 토글]');
  await page.evaluate((id) => window.__app.selectBlock(id), TARGET);
  await page.click(`.bk[data-id="${TARGET}"]`);
  check('선택된 블록을 다시 누르면 해제된다',
    await page.evaluate(() => window.__app.state.selectedId) === null);
  await page.click(`.bk[data-id="${TARGET}"]`);
  check('한 번 더 누르면 다시 선택된다',
    await page.evaluate(() => window.__app.state.selectedId) === TARGET);

  console.log('\n[되돌리기]');
  await page.evaluate((id) => window.__app.selectBlock(id), TARGET);
  await page.click('#revertBtn');
  s = await snap();
  check('원문으로 되돌아간다', s.block.edited === before && s.block.draft === before);
  check('dirty 가 해제된다', s.block.dirty === false);
  check('수정 개수가 사라진다', s.dirtyCount === '', s.dirtyCount);

  console.log('\n[잠긴 블록]');
  const lockedId = await page.evaluate(() => (window.__app.state.blocks.find((b) => b.locked) || {}).id);
  if (lockedId) {
    await page.click(`.bk[data-id="${lockedId}"]`);
    s = await snap();
    check('잠긴 블록도 선택은 된다', s.selected === lockedId);
    check('입력창이 비활성화된다', await page.getAttribute('#editorText', 'disabled') !== null);
    check('안내 문구가 뜬다', /바꿀 수 없습니다/.test(await page.textContent('#verdict')));
  } else {
    console.log('  (잠긴 블록 없음 — 건너뜀)');
  }

  console.log('\n[비교 화면]');
  await page.evaluate(async (id) => {
    const app = window.__app;
    app.selectBlock(id);
    app.state.blocks.find((b) => b.id === id).draft = '비교용';
    await app.saveBlock();
  }, TARGET);
  check('저장 직후에는 선택이 유지된다',
    await page.evaluate(() => window.__app.state.selectedId) === TARGET);
  await page.click('#viewToggle button[data-view="original"]');
  check('원본/결과를 전환하면 선택이 풀린다',
    await page.evaluate(() => window.__app.state.selectedId) === null);
  await page.evaluate(() => window.__app.revertBlock && null);
  await page.evaluate(async (id) => {
    const app = window.__app;
    app.selectBlock(id); await app.revertBlock();
    app.selectBlock(null);
  }, TARGET);

  console.log('\n[영역 표시 토글]');
  // 표시를 꺼도 상자는 남는다(투명). 보이는 것과 고를 수 있는 것은 다른 문제다.
  await page.evaluate((id) => window.__app.selectBlock(id), TARGET);
  const boxCount = () => page.evaluate(() => document.querySelectorAll('#overlay .bk').length);
  const visCount = () => page.evaluate(() =>
    document.querySelectorAll('#overlay .bk:not(.ghost)').length);
  const nAll = await page.evaluate(() => window.__app.state.blocks.length);
  check('기본은 전체 표시', await visCount() === nAll, `${await visCount()}/${nAll}`);
  await page.click('#regionsBtn');
  check('끄면 선택한 블록만 보인다', await visCount() === 1, String(await visCount()));
  check('안 보여도 상자는 남아 있다', await boxCount() === nAll, `${await boxCount()}/${nAll}`);
  await page.click('#editorClose');
  check('선택까지 풀면 화면이 깨끗해진다', await visCount() === 0, String(await visCount()));

  // 예전에는 여기서 미리보기 클릭이 아무 일도 안 했다. 목록에서만 고를 수 있었다.
  const other = await page.evaluate(() => window.__app.state.blocks[0].id);
  await page.click(`#overlay .bk[data-id="${other}"]`);
  check('표시를 꺼도 미리보기 클릭으로 고를 수 있다',
    await page.evaluate(() => window.__app.state.selectedId) === other,
    await page.evaluate(() => window.__app.state.selectedId));
  await page.click('#editorClose');
  await page.click('#regionsBtn');

  // 미리보기가 잘리지 않는가 (v1.8).
  // 캔버스에 max-width 만 걸려 있어 세로가 긴 이미지가 잘렸다.
  // 실측: 스테이지 819px 에 캔버스 921px — 위아래가 화면 밖으로 나갔다.
  console.log('\n[미리보기 맞춤]');
  for (const [vw, vh] of [[1600, 1000], [1400, 820], [820, 1000]]) {
    await page.setViewportSize({width: vw, height: vh});
    await page.waitForTimeout(120);
    const m = await page.evaluate(() => {
      const st = document.getElementById('stage'), cv = document.getElementById('preview');
      const sr = st.getBoundingClientRect(), cr = cv.getBoundingClientRect();
      return {
        fits: cr.top >= sr.top - 1 && cr.bottom <= sr.bottom + 1
           && cr.left >= sr.left - 1 && cr.right <= sr.right + 1,
        ratio: cr.height ? cr.width / cr.height : 0,
        want: cv.width / cv.height,
        cw: Math.round(cr.width), ch: Math.round(cr.height),
        sw: Math.round(sr.width), sh: Math.round(sr.height),
      };
    });
    check(`${vw}x${vh} 에서 이미지가 통째로 보인다`, m.fits,
      `캔버스 ${m.cw}x${m.ch} / 스테이지 ${m.sw}x${m.sh}`);
    check(`${vw}x${vh} 에서 비율이 안 망가진다`, Math.abs(m.ratio - m.want) < 0.02,
      `${m.ratio.toFixed(3)} vs ${m.want.toFixed(3)}`);
  }
  await page.setViewportSize({width: 1280, height: 900});
  await page.waitForTimeout(120);

  console.log('\n[키보드]');
  await page.click('.topbar h1');           // 중립 영역 — 선택을 건드리지 않는다
  await page.click('#blockList .item:nth-child(1)');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  s = await snap();
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('#blockList .item')].map((n) => n.dataset.id));
  check('방향키로 아래로 이동한다', s.selected === ids[2], s.selected);
  await page.keyboard.press('ArrowUp');
  s = await snap();
  check('방향키로 위로 이동한다', s.selected === ids[1], s.selected);
  await page.keyboard.press('Enter');
  check('Enter 로 입력창에 포커스가 간다',
    await page.evaluate(() => document.activeElement.id === 'editorText'));
  await page.keyboard.type(' (수정)');
  await page.keyboard.press('Control+Enter');
  s = await snap();
  check('Ctrl+Enter 로 저장된다', s.block.dirty === true && /\(수정\)$/.test(s.block.edited));

  await page.click('#blockList .item:nth-child(1)');
  await page.screenshot({path: path.join(OUT, 'edit-sample-complex.png'), fullPage: true});

  console.log(`\n통과 ${pass} · 실패 ${fail}${errors.length ? `\n콘솔 오류: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  server.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
