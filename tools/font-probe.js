/* 폰트 자동판별(M5) 검증 도구. 배포물이 아니다.
 *   NODE_PATH=$(npm root -g) node tools/font-probe.js
 *
 * 블록별 판별 결과와 유사도를 뽑고, 고정 폰트를 썼을 때와 비교한다.
 * 판별이 "더 닮게" 만드는지를 수치로 확인하는 것이 목적이다.
 */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 8938;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 980}});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  for (const file of ['assets/sample-simple.png', 'assets/sample-complex.png']) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.setInputFiles('#fileInput', path.join(ROOT, file));
    await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
      null, {timeout: 300000});

    const r = await page.evaluate(async () => {
      const s = window.__app.state;
      // 같은 조건에서 고정 폰트(Noto Sans KR 700)의 유사도도 재 비교 기준을 만든다.
      const fixed = {family: 'Noto Sans KR', weight: 700};
      const rows = [];
      for (const b of s.blocks) {
        if (!b.detectedFont) continue;
        const all = await FontMatch.detectFor(s.imageData, b);
        const f = all.ranking.find((x) => x.font === FontMatch.label(fixed));
        rows.push({
          id: b.id, tier: b.tier,
          text: (b.originalText || '').split('\n')[0].slice(0, 22),
          font: FontMatch.label(b.detectedFont),
          score: b.detectedFont.score, gap: b.detectedFont.gap,
          low: b.detectedFont.lowConfidence,
          top3: all.ranking.slice(0, 3).map((x) => `${x.font} ${(x.score * 100).toFixed(0)}%`),
          fixedScore: f ? f.score : null,
        });
      }
      return {rows, ms: s.timing.font, total: s.blocks.length};
    });

    console.log(`\n=== ${path.basename(file)}  판별 ${r.rows.length}/${r.total} 블록  (${(r.ms / 1000).toFixed(1)}s)`);
    for (const x of r.rows) {
      console.log(`  ${x.id.padEnd(4)}[${x.tier}] ${(x.score * 100).toFixed(0).padStart(3)}%`
        + ` 격차${(x.gap * 100).toFixed(1).padStart(5)}%p ${x.low ? '⚠' : ' '} ${x.font.padEnd(20)} "${x.text}"`);
      console.log(`        후보: ${x.top3.join('  |  ')}`);
    }
    const withFixed = r.rows.filter((x) => x.fixedScore !== null);
    if (withFixed.length) {
      const a = withFixed.reduce((s2, x) => s2 + x.score, 0) / withFixed.length;
      const b = withFixed.reduce((s2, x) => s2 + x.fixedScore, 0) / withFixed.length;
      console.log(`  평균 유사도 — 자동판별 ${(a * 100).toFixed(1)}%  vs  고정(Noto Sans KR 700) ${(b * 100).toFixed(1)}%`);
      check('자동판별이 고정 폰트보다 낫거나 같다', a >= b - 1e-9, `${(a * 100).toFixed(1)}% vs ${(b * 100).toFixed(1)}%`);
    }
  }

  // 샘플 A 는 M0 에서 이미 정답을 확인했다. 같은 결과가 나오는지 본다.
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-simple.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});

  console.log('\n[M0 결과와 대조]');
  const m0 = await page.evaluate(() => window.__app.state.blocks.map((b) =>
    ({id: b.id, font: b.detectedFont ? FontMatch.label(b.detectedFont) : null})));
  check('흰 반투명 줄은 얇은 고딕으로 판별된다',
    /Noto Sans KR 400|Gothic A1 400|Nanum Gothic 400/.test(m0[0].font || ''), m0[0].font);
  check('빨간 굵은 줄은 굵은 폰트로 판별된다',
    /900|800|Black Han Sans/.test(m0[1].font || ''), m0[1].font);

  console.log('\n[직접 선택 모드]');
  check('드롭다운이 활성화된다', await page.getAttribute('#fontSelect', 'disabled') === null);
  await page.selectOption('#fontSelect', {label: 'Black Han Sans 400'});
  const mode = await page.evaluate(() => ({
    mode: window.__app.state.fontMode,
    sel: FontMatch.label(window.__app.state.selectedFont),
    used: FontMatch.label(window.__app.fontFor(window.__app.state.blocks[0])),
  }));
  check('선택한 폰트가 상태에 반영된다', mode.sel === 'Black Han Sans 400', mode.sel);
  check('직접 선택이 판별 결과를 덮어쓴다', mode.used === 'Black Han Sans 400', mode.used);
  check('목록에 직접 선택 표시가 뜬다',
    /직접 선택/.test(await page.textContent('#blockList')));

  await page.selectOption('#fontSelect', {label: '자동판별'});
  const back = await page.evaluate(() => FontMatch.label(window.__app.fontFor(window.__app.state.blocks[0])));
  check('자동으로 되돌리면 판별 결과를 다시 쓴다', back === m0[0].font, back);

  await page.screenshot({path: path.join(OUT, 'font-sample-simple.png'), fullPage: true});

  console.log(`\n통과 ${pass} · 실패 ${fail}${errors.length ? `\n콘솔 오류: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  server.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
