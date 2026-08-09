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
      await app.saveBlock();      // 저장이 곧 합성이다

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

  // ---- 유형 B (단색 배경) ----
  console.log('\n[유형 B — 단색 배경 채우기]');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-complex.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});

  const rb = await page.evaluate(async () => {
    const app = window.__app, s = app.state;
    // 파란 정보 박스 한 줄과 검은 원 배지를 함께 고친다.
    const edits = [
      {tier: 'B', match: /이벤트 기간/, text: '이벤트 기간 : ~12/31(수)까지'},
      {tier: 'B', match: /추첨/, text: '추첨\n9명'},
    ];
    const done = [];
    for (const e of edits) {
      const b = s.blocks.find((x) => x.tier === e.tier && !x.locked && e.match.test(x.originalText || ''));
      if (!b) continue;
      app.selectBlock(b.id);
      b.draft = e.text;
      await app.saveBlock();
      done.push({id: b.id, from: b.originalText, to: e.text, bg: b.bgColor, box: b.bbox});
    }

    const c2 = document.createElement('canvas');
    c2.width = s.imageData.width; c2.height = s.imageData.height;
    c2.getContext('2d').drawImage(s.result, 0, 0);
    return {edits: done, notes: s.composeNotes, ms: s.timing.compose, png: c2.toDataURL('image/png')};
  });

  fs.writeFileSync(path.join(OUT, 'compose-유형B.png'),
    Buffer.from(rb.png.split(',')[1], 'base64'));
  for (const e of rb.edits) {
    console.log(`  ${e.id}  "${(e.from || '').replace(/\n/g, ' ⏎ ')}"  →  "${e.to.replace(/\n/g, ' ⏎ ')}"  배경 rgb(${e.bg})`);
  }
  check('유형 B 블록이 건너뛰어지지 않는다',
    !rb.notes.some((n) => n.level === 'skip'), rb.notes.map((n) => n.text).join(' / ') || '건너뜀 없음');
  check('유형 B 편집이 실제로 적용됐다', rb.edits.length === 2, `${rb.edits.length}건`);
  console.log(`       조치: ${rb.notes.length ? rb.notes.map((n) => n.text).join(' / ') : '없음'}  (${rb.ms}ms)`);

  console.log('\n[원본/결과 토글]');
  // 한 버튼이 이름을 바꾸는 대신, 두 버튼이 함께 뜨고 켜진 쪽이 칠해진다.
  const onView = () => page.evaluate(() =>
    [...document.querySelectorAll('#viewToggle button')]
      .filter((b) => b.classList.contains('on')).map((b) => b.dataset.view));
  check('저장 직후에는 결과를 보고 있다',
    await page.evaluate(() => window.__app.state.showing) === 'result');
  check('결과 쪽이 켜져 있다', JSON.stringify(await onView()) === '["result"]',
    JSON.stringify(await onView()));
  check('두 선택지가 함께 보인다',
    await page.evaluate(() => document.querySelectorAll('#viewToggle button').length) === 2);
  await page.click('#viewToggle button[data-view="original"]');
  check('원본을 누르면 원본으로 바뀐다',
    await page.evaluate(() => window.__app.state.showing) === 'original');
  check('원본 쪽이 켜진다', JSON.stringify(await onView()) === '["original"]',
    JSON.stringify(await onView()));
  await page.click('#viewToggle button[data-view="result"]');
  check('결과로 되돌아온다',
    await page.evaluate(() => window.__app.state.showing) === 'result');

  // 그림 위 글자는 그림 밖으로 나가면 안 된다. roomFor 는 다른 '글자 블록'만
  // 보므로 검은 원 배지 옆이 비어 있다고 판단한다 — 실제 자리는 원 안쪽뿐이다.
  const badge = await page.evaluate(() => {
    const st = window.__app.state;
    const {roomFor, usableWidth, bgExtent} = Compose.util;
    const blk = st.blocks.find((x) => (x.originalText || '').startsWith('추첨') && !x.locked);
    if (!blk) return null;
    const line = blk.lines[blk.lines.length - 1].bbox;
    const nb = roomFor(line, st.blocks, blk.id, st.imageData.width);
    const bg = bgExtent(st.imageData.data, st.imageData.width, st.imageData.height, blk);
    const merged = bg ? {left: Math.max(nb.left, bg.left), right: Math.min(nb.right, bg.right)} : nb;
    return {
      neighbourOnly: Math.round(usableWidth(line, 'center', nb)),
      withPatch: Math.round(usableWidth(line, 'center', merged)),
      patch: bg ? bg.right - bg.left : null,
    };
  });
  if (badge) {
    console.log(`  배지 — 이웃만 보면 ${badge.neighbourOnly}px, 바탕까지 보면 ${badge.withPatch}px`
      + ` (원 지름 ${badge.patch}px)`);
    check('그림 위 글자는 그림 밖으로 못 나간다',
      badge.withPatch <= badge.patch && badge.withPatch < badge.neighbourOnly / 2,
      `${badge.neighbourOnly} → ${badge.withPatch}`);
  }

  // ---- 오버플로 (v1.7 재작성) ----
  //
  // 예전에는 넘치면 무조건 자간부터 5% 깎고 폰트를 줄였다. 옆이 비어 있어도
  // 그랬고, 1px 이 넘쳐도 그랬다. 사용자가 `합격`→`불합격`, `50`→`60` 을
  // 넣었을 때 낱말 사이가 사라지고 획이 얇아진 원인이다.
  console.log('\n[넘칠 때의 처리]');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setInputFiles('#fileInput', path.join(ROOT, 'assets/sample-headline.png'));
  await page.waitForFunction(() => window.__app.state.imageData && !window.__app.state.analyzing,
    null, {timeout: 300000});

  const ov = await page.evaluate(() => {
    const st = window.__app.state;
    const {layout, fitTracking, roomFor, usableWidth, resolveOverflow, setFont, inkMetrics} = Compose.util;
    const c = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
    const run = (key, text) => {
      const blk = st.blocks.find((x) => (x.originalText || '').includes(key));
      if (!blk) return null;
      const font = window.__app.fontFor(blk);
      const L = layout(c, blk, font);
      const box = L.boxes[0], targetW = box.x1 - box.x0;
      const track = fitTracking(c, font, L.srcLines[0], L.size, targetW);
      const avail = usableWidth(box, L.align, roomFor(box, st.blocks, blk.id, st.imageData.width));
      setFont(c, font, L.size, track);
      const w = inkMetrics(c, text).w;
      const f = resolveOverflow(c, font, text, L.size, track, box, avail);
      return {size: L.size, track, avail, targetW, over: w - targetW,
              fitSize: f.size, fitTrack: f.track, note: f.note};
    };
    const src = (key) => (st.blocks.find((x) => (x.originalText || '').includes(key)).originalText);
    return {
      big:   run('초시때', src('초시때').replace('합격', '불합격')),
      tiny:  run('공단기로', src('공단기로').replace('50만원', '60만원')),
      // 옆이 막힐 만큼 아주 길게 — 이때는 좁히는 게 맞다
      huge:  run('공단기로', src('공단기로').repeat(4)),
    };
  });

  const same = (a, b) => Math.abs(a - b) < 1e-6;
  console.log(`  6.5% 넘침  → 크기 ${ov.big.fitSize.toFixed(1)} (원래 ${ov.big.size.toFixed(1)})`
    + ` · 자간 ${ov.big.fitTrack.toFixed(2)} (원래 ${ov.big.track.toFixed(2)}) · 여유 ${Math.round(ov.big.avail)}px`);
  console.log(`  0.1% 넘침  → 크기 ${ov.tiny.fitSize.toFixed(1)} · 자간 ${ov.tiny.fitTrack.toFixed(2)}`);
  console.log(`  4배 길이   → 크기 ${ov.huge.fitSize.toFixed(1)} · 자간 ${ov.huge.fitTrack.toFixed(2)} · ${ov.huge.note}`);

  check('옆이 비어 있으면 크기를 안 줄인다',
    same(ov.big.fitSize, ov.big.size) && same(ov.tiny.fitSize, ov.tiny.size),
    `${ov.big.fitSize.toFixed(1)}/${ov.big.size.toFixed(1)}`);
  check('옆이 비어 있으면 자간을 안 좁힌다',
    same(ov.big.fitTrack, ov.big.track) && same(ov.tiny.fitTrack, ov.tiny.track),
    `${ov.big.fitTrack.toFixed(2)}/${ov.big.track.toFixed(2)}`);
  check('조금 넘친 것에 큰 압축을 걸지 않는다',
    ov.tiny.over > 0 && ov.tiny.over < 5 && same(ov.tiny.fitTrack, ov.tiny.track),
    `${ov.tiny.over.toFixed(1)}px 넘침`);
  check('정말 길면 그때는 줄인다',
    ov.huge.fitSize < ov.huge.size && !!ov.huge.note,
    `${ov.huge.fitSize.toFixed(1)} < ${ov.huge.size.toFixed(1)}`);
  check('넓어지면 사용자에게 알린다', /넓어졌습니다/.test(ov.big.note || ''), ov.big.note);

  // 가운데 정렬은 좁은 쪽이 한계다. 좌우 경계 사이 거리를 그대로 쓰면 이웃을 밟는다.
  const usable = await page.evaluate(() => {
    const {usableWidth} = Compose.util;
    const box = {x0: 100, y0: 0, x1: 200, y1: 10};
    const bounds = {left: 50, right: 1000};
    return {
      left: usableWidth(box, 'left', bounds),
      right: usableWidth(box, 'right', bounds),
      center: usableWidth(box, 'center', bounds),
    };
  });
  check('가운데 정렬은 좁은 쪽 기준으로 잰다', usable.center === 200,
    `왼쪽 ${usable.left} · 오른쪽 ${usable.right} · 가운데 ${usable.center}`);

  await page.screenshot({path: path.join(OUT, 'compose-result-view.png'), fullPage: true});

  console.log(`\n통과 ${pass} · 실패 ${fail}${errors.length ? `\n콘솔 오류: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  server.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
