# 이미지 텍스트 교체 툴

투명·단색 배경 이미지의 글자를 추출·수정해 새 문구로 교체하는 **서버 없는 정적 웹 앱**.
업로드한 이미지는 브라우저 밖으로 나가지 않는다.

기획·설계·검증 기록은 **[PLAN.md](./PLAN.md)** 에 있다.

## 현재 상태

| 마일스톤 | 내용 | 상태 |
|---|------|------|
| M0 | 제거 → 재합성 스파이크 | ✅ 통과 ([PLAN.md 부록 B](./PLAN.md#부록-b-m0-스파이크-결과)) |
| M1 | 업로드 · 체커보드 미리보기 · Canvas 로드 | ✅ 완료 |
| M2 | 블록 분리 · OCR · 블록 목록 | 예정 |
| M3 | 블록 선택 · 편집 · 저장 | 예정 |
| M4 / M4.5 | 합성 (유형 A / 유형 B) | 예정 |
| M5 | 폰트 직접 선택 · 자동판별 | 예정 |
| M6 | 다운로드 · GitHub Pages 배포 | 예정 |

## 실행

빌드 과정이 없다. 정적 파일을 그대로 서빙하면 된다.

```bash
npx http-server . -p 8080     # 또는 아무 정적 서버
# http://127.0.0.1:8080
```

`file://` 로 직접 열면 웹폰트·이미지 로딩이 브라우저 보안 정책에 막히므로
반드시 HTTP로 서빙한다.

## 구조

```
index.html      단일 페이지 UI
css/            스타일
js/app.js       플로우 오케스트레이션·상태관리
fonts/          웹폰트 후보 13종 (woff2) + fonts.css
assets/         기준 샘플 이미지
tools/          검증 도구 (배포물 아님)
spike/          M0 스파이크 (M1 이후 폐기 예정)
```

## 검증 도구

배포에 포함되지 않는다. `NODE_PATH=$(npm root -g)` 는 전역 설치된
playwright·http-server 를 쓰기 위한 것이다.

```bash
NODE_PATH=$(npm root -g) node tools/screenshot.js   # 샘플 업로드 후 화면 캡처
NODE_PATH=$(npm root -g) node spike/run.js          # M0 파이프라인 재실행
python3 tools/tier-probe.py                         # 배경 유형 판정 검증
```

## 폰트 라이선스

등록된 웹폰트 13종은 전부 **SIL Open Font License 1.1** 이다. 임베드·재배포·상업적
이용에 제약이 없어 외부 공개 배포가 가능하다. 브랜드 전용 폰트를 추가할 때는
그 폰트의 라이선스를 별도로 확인해야 한다. 자세한 목록은 [PLAN.md 8-1](./PLAN.md).
