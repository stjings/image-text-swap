# 이미지 텍스트 교체 툴

투명·단색 배경 이미지의 글자를 추출·수정해 새 문구로 교체하는 **서버 없는 정적 웹 앱**.
업로드한 이미지는 브라우저 밖으로 나가지 않는다.

기획·설계·검증 기록은 **[PLAN.md](./PLAN.md)** 에 있다.

## 현재 상태

| 마일스톤 | 내용 | 상태 |
|---|------|------|
| M0 | 제거 → 재합성 스파이크 | ✅ 통과 ([PLAN.md 부록 B](./PLAN.md#부록-b-m0-스파이크-결과)) |
| M1 | 업로드 · 체커보드 미리보기 · Canvas 로드 | ✅ 완료 |
| M2 | 배경 유형 판정 · 블록 분리 · OCR | ✅ 완료 ([PLAN.md 부록 C](./PLAN.md#부록-c-m2-결과)) |
| M3 | 블록 선택 · 편집 · 저장 | ✅ 완료 ([PLAN.md 부록 D](./PLAN.md#부록-d-m3-결과)) |
| M4 | 합성 (유형 A) | ✅ 완료 ([PLAN.md 부록 E](./PLAN.md#부록-e-m4-결과)) |
| M4.5 | 합성 (유형 B) | ✅ 완료 ([PLAN.md 부록 F](./PLAN.md#부록-f-m45-결과)) |
| M5 | 폰트 직접 선택 · 자동판별 | ✅ 완료 ([PLAN.md 부록 G](./PLAN.md#부록-g-m5-결과)) |
| M6 | 다운로드 · GitHub Pages 배포 | ✅ 완료 ([PLAN.md 부록 H](./PLAN.md#부록-h-m6-결과)) |

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
js/detect.js    배경 유형 판정 · 잉크 검출 · 블록 분리 · 색 추출
js/ocr.js       Tesseract.js 래퍼 (전처리 · 인식)
js/compose.js   제거 · 렌더 · 자간 · 합성 · 오버플로
js/fontmatch.js 폰트 후보 렌더 · 실루엣 비교 · 자동판별
js/localfont.js 사용자 PC에 설치된 폰트를 후보로 등록
fonts/          웹폰트 25종 (woff2) + fonts.css
vendor/         Tesseract 자산 자체 호스팅 (약 17MB)
assets/         기준 샘플 이미지
tools/          검증 도구 (배포물 아님)
spike/          M0 스파이크 (M1 이후 폐기 예정)
```

## 검증 도구

배포에 포함되지 않는다. `NODE_PATH=$(npm root -g)` 는 전역 설치된
playwright·http-server 를 쓰기 위한 것이다.

```bash
NODE_PATH=$(npm root -g) node tools/screenshot.js   # 업로드 → 검출 → OCR 전 과정
NODE_PATH=$(npm root -g) node tools/detect-probe.js # 검출 결과 + 경계 시각화
NODE_PATH=$(npm root -g) node tools/edit-probe.js   # 선택·편집·저장 상호작용 검사
NODE_PATH=$(npm root -g) node tools/compose-probe.js # 합성·오버플로·픽셀 보존 검사
NODE_PATH=$(npm root -g) node tools/font-probe.js    # 폰트 판별·직접 선택 검사
NODE_PATH=$(npm root -g) node tools/deploy-probe.js  # 배포물·하위경로·다운로드 검사
NODE_PATH=$(npm root -g) node tools/localfont-probe.js # 내 PC 폰트 등록·후보 편입 검사
NODE_PATH=$(npm root -g) node spike/run.js          # M0 파이프라인 재실행
python3 tools/tier-probe.py                         # 배경 유형 판정 검증
```

## 배포

`.github/workflows/pages.yml` 이 푸시마다 GitHub Pages 로 배포한다.
검증용 디렉터리(`tools/` · `spike/` · `assets/`)는 배포물에서 빠진다.

워크플로가 `configure-pages` 의 `enablement` 로 Pages 를 직접 켜므로 **저장소
설정을 손으로 바꿀 필요가 없다.**

배포 주소: **https://stjings.github.io/image-text-swap/**

최초 1회 약 13.5MB(OCR 엔진·언어 데이터·웹폰트)를 내려받는다. 이후에는 브라우저
캐시가 처리한다.

## 폰트 라이선스

자동판별 후보는 디자인팀이 실제로 쓰는 **SUIT · Pretendard · Noto Sans KR** 세
패밀리(15종)다. 그 외 10종은 직접 선택으로만 고를 수 있다. 등록된 폰트는 전부
**SIL Open Font License 1.1** 이다. 임베드·재배포·상업적
이용에 제약이 없어 외부 공개 배포가 가능하다. 자세한 목록은 [PLAN.md 8-1](./PLAN.md).

### 유료 폰트 (산돌 등)

번들하지 않는다. 저장소에 넣으면 재배포가 되고, 글자 모양을 보고 다시 그리는 것은
복제본이다. 대신 상단바의 **`＋ 내 PC 폰트`** 로 **이 PC에 설치된 폰트**를 등록하면
자동판별 후보에 들어간다. 폰트 파일은 네트워크로 오가지 않는다(요청 0건으로 확인 —
[PLAN.md 부록 I](./PLAN.md#부록-i-내-pc-폰트-결과-v14)). 폰트를 산 사람의 PC에서만
맞고, 없는 사람에게는 후보에 뜨지 않는다. 결과 이미지는 그림이라 누구에게나 같게
보이므로 편집하는 사람만 폰트를 갖고 있으면 된다. 설계 근거는 [PLAN.md 8-2](./PLAN.md).
