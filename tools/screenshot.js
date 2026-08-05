/* 앱 화면 검증용 스크린샷 도구. 배포물이 아니다.
 *
 *   NODE_PATH=$(npm root -g) node tools/screenshot.js        (저장소 루트에서)
 *
 * 기준 샘플 2종을 실제로 업로드해 화면을 캡처하고, 화면에 표시된 값을 콘솔로 뽑는다.
 * 마일스톤 완료 판정(PLAN.md 12장)을 눈과 수치로 함께 확인하기 위한 것이다.
 */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 8932;

const CASES = [
  {name: 'empty', file: null},
  {name: 'sample-simple', file: 'assets/sample-simple.png'},
  {name: 'sample-complex', file: 'assets/sample-complex.png'},
];

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  for (const c of CASES) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.waitForLoadState('networkidle');

    if (c.file) {
      await page.setInputFiles('#fileInput', path.join(ROOT, c.file));
      await page.waitForSelector('#viewport:not([hidden])');
      // 검출 + OCR 완료까지 기다린다. 최초 1회는 엔진·언어데이터 로딩이 있어 오래 걸린다.
      await page.waitForFunction(
        () => window.__app.state.imageData && !window.__app.state.analyzing,
        null, {timeout: 300000});
    }
    await page.screenshot({path: path.join(OUT, `${c.name}.png`), fullPage: true});

    const info = c.file ? await page.evaluate(() => {
      const s = window.__app.state;
      return {
        file: s.fileName, hasAlpha: s.hasAlpha,
        canvas: [document.getElementById('preview').width, document.getElementById('preview').height],
        info: [...document.querySelectorAll('#imgInfo > div')]
          .map((d) => `${d.querySelector('dt').textContent}=${d.querySelector('dd').textContent}`).join('  '),
      };
    }) : null;

    console.log(`[${c.name}]`);
    if (info) {
      console.log(`  캔버스 ${info.canvas[0]}x${info.canvas[1]}  알파채널 ${info.hasAlpha ? '있음' : '없음'}`);
      console.log(`  ${info.info}`);
      const blocks = await page.evaluate(() => window.__app.state.blocks.map(b => ({
        id: b.id, tier: b.tier, n: b.lines.length,
        conf: Math.round(b.confidence || 0), text: b.originalText,
      })));
      const tm = await page.evaluate(() => window.__app.state.timing);
      console.log(`  블록 ${blocks.length}개  (검출 ${tm.detect}ms · OCR ${(tm.ocr/1000).toFixed(1)}s)`);
      for (const b of blocks) {
        const t = (b.text || '(인식 실패)').replace(/\n/g, ' ⏎ ');
        console.log(`    ${b.id.padEnd(4)}[${b.tier}] ${String(b.conf).padStart(3)}%  ${t}`);
      }
    } else {
      console.log('  초기 화면');
    }
  }

  // 배경 토글 검증. 샘플 A 1행은 흰색 반투명이라 밝은 배경에서는 보이지 않는다.
  // 검정 배경으로 바꿔야 드러나는지가 이 토글의 존재 이유다(PLAN.md 4장).
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-simple.png'));
  await page.waitForSelector('#viewport:not([hidden])');
  await page.click('#bgToggle button[data-bg="dark"]');
  const cls = await page.getAttribute('#stage', 'class');
  console.log(`\n배경 토글(검정) → stage class = "${cls}"`);
  await page.screenshot({path: path.join(OUT, 'sample-simple-dark.png'), fullPage: true});

  console.log(errors.length ? `\n콘솔 오류 ${errors.length}건:\n  ${errors.join('\n  ')}` : '\n콘솔 오류 없음');

  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
})();
