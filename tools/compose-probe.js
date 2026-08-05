/* 합성(M4) 검증 도구. 배포물이 아니다.
 *   NODE_PATH=$(npm root -g) node tools/compose-probe.js
 *
 * 문구를 길게/짧게 바꿔가며 합성하고, 결과 이미지와 조치 사유를 남긴다.
 * 핵심 검사는 "수정하지 않은 블록이 원본 픽셀 그대로인가" 이다.
 */
const {chromium} = require('playwright');
const http = require('http-server');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 8936;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

const CASES = [
  {name: '동일-길이', id: 'b1', text: '2028 합격을 위한 헌법\n정답은, 써니 뿐입니다.'},
  {name: '짧은-문구', id: 'b1', text: '2028 헌법\n써니.'},
  {name: '긴-문구', id: 'b1',
   text: '2028 공무원 시험 합격을 위한 행정법 완전정복\n결국, 써니 선생님 뿐입니다 여러분.'},
];

(async () => {
  fs.mkdirSync(OUT, {recursive: true});
  const server = http.createServer({root: ROOT, cache: -1});
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  for (const c of CASES) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-simple.png'));
    await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
      null, {timeout: 300000});

    const r = await page.evaluate(async ({id, text}) => {
      const app = window.__app, s = app.state;
      app.selectBlock(id);
      const b = s.blocks.find((x) => x.id === id);
      b.draft = text;
      app.saveBlock();
      await app.runCompose();

      // 수정하지 않은 블록 영역이 원본과 픽셀 단위로 같은지 확인한다.
      const c2 = document.createElement('canvas');
      c2.width = s.imageData.width; c2.height = s.imageData.height;
      const cx = c2.getContext('2d', {willReadFrequently: true});
      cx.drawImage(s.result, 0, 0);
      const res = cx.getImageData(0, 0, c2.width, c2.height).data;
      const src = s.imageData.data;
      const W = c2.width;
      const untouched = s.blocks.filter((x) => !x.dirty);
      let diff = 0, checked = 0;
      for (const u of untouched) {
        for (let y = u.bbox.y0; y < u.bbox.y1; y++) {
          for (let x = u.bbox.x0; x < u.bbox.x1; x++) {
            const i = (y * W + x) * 4;
            checked++;
            for (let k = 0; k < 4; k++) if (src[i + k] !== res[i + k]) { diff++; k = 4; }
          }
        }
      }
      return {
        notes: s.composeNotes, ms: s.timing.compose,
        untouchedIds: untouched.map((x) => x.id), checked, diff,
        png: s.result.toDataURL('image/png'),
      };
    }, c);

    fs.writeFileSync(path.join(OUT, `compose-${c.name}.png`),
      Buffer.from(r.png.split(',')[1], 'base64'));

    console.log(`\n[${c.name}]  "${c.text.replace(/\n/g, ' ⏎ ')}"  (${r.ms}ms)`);
    check('수정 안 한 블록이 원본 픽셀 그대로다',
      r.diff === 0, `${r.untouchedIds.join(',')} · ${r.checked}px 중 ${r.diff}px 다름`);
    console.log(`       조치: ${r.notes.length ? r.notes.map((n) => n.text).join(' / ') : '없음'}`);
  }

  // 원본/결과 토글
  const tg = await page.evaluate(() => {
    const app = window.__app;
    app.showResult(false);
    const a = document.getElementById('overlay').style.display;
    app.showResult(true);
    const b = document.getElementById('overlay').style.display;
    return {原: a, 結: b, label: document.getElementById('toggleBtn').textContent};
  });
  console.log('\n[토글]');
  check('결과 화면에서 오버레이가 숨겨진다', tg.原 === '' && tg.結 === 'none');
  check('버튼 라벨이 바뀐다', tg.label === '원본 보기', tg.label);

  await page.screenshot({path: path.join(OUT, 'compose-result-view.png'), fullPage: true});

  console.log(`\n통과 ${pass} · 실패 ${fail}${errors.length ? `\n콘솔 오류: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  server.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
