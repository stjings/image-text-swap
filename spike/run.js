// M0 스파이크 실행기 — 헤드리스 Chromium에서 m0.html 을 돌리고 결과를 파일로 저장한다.
//   NODE_PATH=$(npm root -g) node spike/run.js      (저장소 루트에서 실행)
const {chromium} = require('playwright');
const http = require('http-server');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'spike', 'out');
const PORT = 8931;

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));

  await page.goto(`http://127.0.0.1:${PORT}/spike/m0.html`);
  await page.waitForFunction(() => window.__RESULT__ || window.__ERROR__, null, {timeout: 120000});

  const err = await page.evaluate(() => window.__ERROR__);
  if (err) { console.error('스파이크 실패:\n' + err); logs.forEach(l => console.error(l)); process.exit(1); }

  const r = await page.evaluate(() => window.__RESULT__);
  for (const [name, url] of Object.entries(r.png)) {
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  delete r.png;
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(r, null, 2));

  console.log(`이미지 ${r.size.W}x${r.size.H}   블록 ${r.blocks.length}개\n`);
  for (const b of r.blocks) {
    const c = b.color;
    console.log(`[${b.idx}] "${b.text}"  →  "${b.replaced}"`);
    console.log(`     bbox=(${b.box.x0},${b.box.y0})-(${b.box.x1},${b.box.y1})  유형=${b.tier} (투명 ${(b.clearRatio * 100).toFixed(0)}%)`);
    console.log(`     색 rgb(${c.top})  불투명도 ${(c.opacity * 100).toFixed(0)}%  크기 ${b.fittedSize}px  자간 ${b.tracking}px`);
    console.log(`     폰트 ${b.font}  (재현도 ${(b.iou * 100).toFixed(1)}%, 2위와 격차 ${(b.gap * 100).toFixed(1)}%p)`);
    console.log(`       후보: ${b.top3.map(t => `${t.font} ${(t.iou * 100).toFixed(1)}%`).join('  |  ')}`);
  }
  console.log(`\n블록 평균 재현도: ${(r.overallIoU * 100).toFixed(1)}%`);

  await browser.close();
  server.close();
})();
