/* 블록 검출(7-1·7-3·7-4) 검증 도구. 배포물이 아니다.
 *   NODE_PATH=$(npm root -g) node tools/detect-probe.js
 * 검출 결과를 콘솔로 뽑고, 블록 경계를 그린 오버레이 이미지를 저장한다. */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'tools', 'shots'), PORT = 8933;

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('PAGEERROR', e.message));

  for (const f of ['assets/sample-simple.png', 'assets/sample-complex.png']) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.setInputFiles('#fileInput', path.join(ROOT, f));
    await page.waitForFunction(() => window.__app.state.imageData !== null);
    const t0 = Date.now();
    const r = await page.evaluate(() => {
      const blocks = Detect.detect(window.__app.state.imageData);
      return blocks.map(b => ({
        id: b.id, tier: b.tier, bbox: b.bbox, lines: b.lines.length,
        color: b.colorTop, opacity: +b.opacity.toFixed(2), bg: b.bgColor,
      }));
    });
    console.log(`\n=== ${f}  →  블록 ${r.length}개  (${Date.now() - t0}ms)`);
    for (const b of r) {
      const {x0, y0, x1, y1} = b.bbox;
      console.log(`  ${b.id} [${b.tier}] (${x0},${y0})-(${x1},${y1}) ${String(x1-x0).padStart(4)}x${String(y1-y0).padStart(3)} `
        + `줄${b.lines} 색rgb(${b.color}) α${b.opacity}` + (b.bg ? ` 배경rgb(${b.bg})` : ''));
    }
    const png = await page.evaluate(() => {
      const s = window.__app.state, im = s.imageData;
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const x = c.getContext('2d');
      x.fillStyle = '#151820'; x.fillRect(0, 0, c.width, c.height);
      x.putImageData(im, 0, 0);
      const g = document.createElement('canvas'); g.width = im.width; g.height = im.height;
      const gx = g.getContext('2d'); gx.drawImage(c, 0, 0);
      for (const b of Detect.detect(im)) {
        const col = {A: '#22d3ee', B: '#a3e635', C: '#f87171'}[b.tier];
        gx.strokeStyle = col; gx.lineWidth = 2;
        gx.strokeRect(b.bbox.x0 - 1, b.bbox.y0 - 1, b.bbox.x1 - b.bbox.x0 + 2, b.bbox.y1 - b.bbox.y0 + 2);
        gx.fillStyle = col; gx.font = '11px sans-serif';
        gx.fillText(`${b.id}${b.tier}`, b.bbox.x0, Math.max(10, b.bbox.y0 - 3));
      }
      return g.toDataURL('image/png');
    });
    fs.writeFileSync(path.join(OUT, 'detect-' + path.basename(f)), Buffer.from(png.split(',')[1], 'base64'));
  }
  await browser.close(); server.close();
})();
