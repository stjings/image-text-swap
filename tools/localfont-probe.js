/* 내 PC 폰트(로컬 폰트 후보) 검증 도구. 배포물이 아니다.
 *   NODE_PATH=$(npm root -g) node tools/localfont-probe.js
 *
 * 확인하려는 것
 *   1. 설치되지 않은 이름은 거부된다 (등록 시도가 설치 여부 검사를 겸한다)
 *   2. 설치된 폰트는 등록되고, 자동판별 후보와 드롭다운 양쪽에 들어간다
 *   3. 실제 판별에서 후보로 겨룬다 (순위표에 점수가 잡힌다)
 *   4. 폰트 파일을 네트워크로 받지 않는다 (재배포가 아님을 수치로 확인)
 *   5. 새로고침하면 다시 등록된다
 *   6. 열거 API 가 없는 브라우저에서도 이름 입력 경로가 살아 있다
 *
 * 이 컨테이너에는 산돌 폰트가 없으므로 시스템에 있는 Liberation Sans 로 대신
 * 검증한다. 등록 경로는 폰트가 무엇이든 같다.
 */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8939;
const TEST_FONT = 'Liberation Sans';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 980}});
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`);

  console.log('\n[패널]');
  await page.click('#localFontBtn');
  check('패널이 열린다', await page.isVisible('#lfPanel'));
  check('등록된 폰트가 없다고 알린다', /아직 없습니다/.test(await page.textContent('#lfAdded')));

  console.log('\n[설치되지 않은 이름]');
  await page.fill('#lfName', 'No Such Font Zzz');
  await page.click('#lfAdd');
  await page.waitForSelector('#lfMsg.err');
  check('거부하고 이유를 말한다', /설치돼 있지 않/.test(await page.textContent('#lfMsg')));
  check('후보에 들어가지 않는다',
    await page.evaluate(() => FontMatch.candidates().length) === 15);

  console.log('\n[설치된 폰트 등록]');
  const before = requests.length;
  await page.fill('#lfName', TEST_FONT);
  await page.click('#lfAdd');
  await page.waitForFunction((n) => LocalFont.list().length === 1, null);
  check('칩으로 표시된다', (await page.textContent('#lfAdded')).includes(TEST_FONT));
  const reg = await page.evaluate(() => {
    const f = LocalFont.list()[0];
    return {
      family: f.family, label: FontMatch.label(f), weight: f.weight,
      cands: FontMatch.candidates().length,
      inCands: FontMatch.candidates().some((c) => c.local),
      opts: [...document.querySelectorAll('#fontSelect option')].map((o) => o.textContent),
    };
  });
  check('자동판별 후보에 들어간다', reg.inCands && reg.cands === 16, `후보 ${reg.cands}종`);
  check('드롭다운에 뜬다', reg.opts.some((t) => t === `${TEST_FONT} · 내 PC`), reg.label);
  check('판별 제외 표시가 붙지 않는다',
    !reg.opts.some((t) => t.startsWith(TEST_FONT) && /판별 제외/.test(t)));
  check('가족 이름이 번들 폰트와 겹치지 않는다', reg.family.startsWith('LF '), reg.family);

  const fontReq = requests.slice(before).filter((u) => /\.(woff2?|ttf|otf)(\?|$)/.test(u));
  check('폰트 파일을 내려받지 않는다 (재배포 아님)', fontReq.length === 0,
    fontReq.length ? fontReq.join(' ') : '요청 0건');

  console.log('\n[실제 렌더]');
  const drawn = await page.evaluate((fam) => {
    const c = document.createElement('canvas').getContext('2d');
    const w = (f) => { c.font = `400 40px "${f}"`; return c.measureText('Hamburgefonstiv 123').width; };
    return {local: w(fam), miss: w('no-such-family-xyz')};
  }, reg.family);
  check('캔버스가 그 폰트로 그린다 (폴백 아님)', drawn.local !== drawn.miss,
    `${drawn.local} vs 폴백 ${drawn.miss}`);

  // 이 컨테이너의 헤드리스 크로미움은 API 는 있지만 폰트를 하나도 돌려주지
  // 않는다. 열거가 막힌 브라우저와 결과가 같으므로, 그 경우를 여기서 본다.
  console.log('\n[열거가 안 될 때]');
  await page.click('#lfScan');
  await page.waitForTimeout(300);
  const scan = await page.evaluate(() => ({
    msg: document.getElementById('lfMsg').textContent,
    listShown: !document.getElementById('lfList').hidden,
  }));
  if (!scan.listShown) {
    check('열거가 안 되면 직접 입력을 안내한다', /직접 적어/.test(scan.msg), scan.msg);
  } else {
    check('목록이 열린다', true, scan.msg);
  }

  console.log('\n[새로고침 후 복구]');
  await page.reload();
  await page.waitForFunction(() => LocalFont.list().length === 1, null, {timeout: 5000});
  const after = await page.evaluate(() => ({
    n: LocalFont.list().length,
    inCands: FontMatch.candidates().some((c) => c.local),
  }));
  check('지난 세션 선택이 되살아난다', after.n === 1 && after.inCands);

  console.log('\n[판별에 실제로 참여]');
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-simple.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});
  const rank = await page.evaluate((label) => {
    const b = window.__app.state.blocks.find((x) => x.detectedFont);
    if (!b) return null;
    const r = b.detectedFont.ranking.find((x) => x.font === label);
    return {
      n: b.detectedFont.ranking.length,
      score: r ? r.score : null,
      winner: b.detectedFont.ranking[0].font,
    };
  }, `${TEST_FONT} · 내 PC`);
  check('순위표에 후보로 잡힌다', rank && rank.score !== null,
    rank ? `${rank.n}종 중 유사도 ${(rank.score * 100).toFixed(1)}% · 1위 ${rank.winner}` : '블록 없음');

  console.log('\n[직접 선택]');
  await page.selectOption('#fontSelect', {label: `${TEST_FONT} · 내 PC`});
  const sel = await page.evaluate(() => ({
    mode: window.__app.state.fontMode,
    label: FontMatch.label(window.__app.state.selectedFont),
    used: FontMatch.label(window.__app.fontFor(window.__app.state.blocks[0])),
  }));
  check('직접 선택으로 고를 수 있다', sel.mode === 'manual' && sel.label === `${TEST_FONT} · 내 PC`,
    `${sel.mode} / ${sel.label}`);
  check('합성이 그 폰트를 쓴다', sel.used === `${TEST_FONT} · 내 PC`, sel.used);
  await page.selectOption('#fontSelect', {label: '자동판별'});

  console.log('\n[제거]');
  await page.click('#localFontBtn');
  await page.click('#lfAdded button');
  await page.waitForFunction(() => !window.__app.state.analyzing && LocalFont.list().length === 0,
    null, {timeout: 60000});
  const gone = await page.evaluate(() => ({
    cands: FontMatch.candidates().length,
    opts: [...document.querySelectorAll('#fontSelect option')].map((o) => o.textContent),
  }));
  check('후보에서 빠진다', gone.cands === 15 && !gone.opts.some((t) => /내 PC/.test(t)));

  console.log(`\n통과 ${pass} · 실패 ${fail}${errors.length ? `\n콘솔 오류: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  server.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
