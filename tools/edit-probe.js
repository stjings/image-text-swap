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

  console.log('\n[선택]');
  await page.click('#blockList .item:nth-child(3)');
  let s = await snap();
  check('목록 클릭으로 선택된다', s.selected === 'b2', s.selected);
  check('편집 패널이 열린다', s.editorHidden === false);

  await page.click('.bk[data-id="b12"]');
  s = await snap();
  check('오버레이 클릭으로도 선택된다', s.selected === 'b12', s.selected);

  console.log('\n[편집·저장]');
  const before = s.block.orig;
  await page.fill('#editorText', '이벤트 기간 : ~9/30(화)까지');
  s = await snap();
  check('입력이 draft 에 반영된다', s.block.draft === '이벤트 기간 : ~9/30(화)까지');
  check('아직 확정되지 않았다', s.block.edited === before && s.block.dirty === false);
  check('저장 버튼이 활성화된다', s.saveDisabled === false);
  check('미저장 표시가 뜬다', /미저장 1/.test(s.dirtyCount) === false && s.dirtyCount === '',
    `dirtyCount="${s.dirtyCount}"`);

  await page.click('#saveBtn');
  s = await snap();
  check('저장하면 확정된다', s.block.edited === '이벤트 기간 : ~9/30(화)까지');
  check('dirty 로 표시된다', s.block.dirty === true);
  check('하단에 수정 개수가 나온다', /수정된 블록 1개/.test(s.dirtyCount), s.dirtyCount);
  check('저장 후 버튼이 비활성화된다', s.saveDisabled === true);

  console.log('\n[필터]');
  const total = (await snap()).shownItems;
  await page.click('#filterBar button[data-filter="dirty"]');
  s = await snap();
  check('수정됨 필터가 1개만 남긴다', s.shownItems === 1, `${s.shownItems}/${total}`);
  await page.click('#filterBar button[data-filter="editable"]');
  s = await snap();
  const locked = await page.evaluate(() => window.__app.state.blocks.filter((b) => b.locked).length);
  check('편집 가능 필터가 잠긴 블록을 뺀다', s.shownItems === total - locked,
    `${s.shownItems} = ${total} - ${locked}`);
  await page.click('#filterBar button[data-filter="all"]');

  console.log('\n[되돌리기]');
  await page.click('.bk[data-id="b12"]');
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
    check('안내 문구가 뜬다', /교체할 수 없습니다/.test(await page.textContent('#editorOrig')));
  } else {
    console.log('  (잠긴 블록 없음 — 건너뜀)');
  }

  console.log('\n[키보드]');
  await page.click('.topbar h1');           // 중립 영역 — 선택을 건드리지 않는다
  await page.click('#blockList .item:nth-child(1)');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  s = await snap();
  check('방향키로 아래로 이동한다', s.selected === 'b2', s.selected);
  await page.keyboard.press('ArrowUp');
  s = await snap();
  check('방향키로 위로 이동한다', s.selected === 'b1', s.selected);
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
