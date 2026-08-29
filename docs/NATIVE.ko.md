# Vision — 네이티브 경로

> 번역본. 정본은 [NATIVE.md](NATIVE.md) 이며 이 문서는 독립 규칙을 정의하지 않는다.

vision pane 의 픽셀은 렌더 사이드카가 그린다. 이 플러그인은 표면을 선언하고 명령을 전달하고
status 를 발행한다.

## 프로세스 지도

| 일 | 프로세스 |
| --- | --- |
| VT 파싱, 그리드 미러, 글리프 래스터화, Metal, IOSurface 링 | 엔진 사이드카(엔진마다 하나) |
| 표면 합성, 키보드·IME·마우스 입력, 기하, 파킹 픽셀 | 애플리케이션(`wails-service-terminal-surface`) |
| shell | pane 마다 PTY 사이드카의 자식 하나 |
| 이 플러그인 | 선언·명령·status — 셀도 글리프도 프레임도 없음 |

pane 은 프로세스를 더하지 않는다. 웹 콘텐츠 프로세스는 뜨거운 경로에 없다.

## 규칙

1. 뜨거운 경로에 웹뷰가 없다: 키·에코·프레임·페인트는 사이드카와 애플리케이션 AppKit 사이만
   오간다.
2. 픽셀은 그리드를 소유한 프로세스가 그린다. 이 저장소에 painter 가 생기면 그것이 이 플러그인이
   없애려는 결함이다.
3. 표면은 선언으로 생긴다. `data-native-*` 속성 일곱 개가 수명이다. 여는 명령은 없다.
4. 거부는 이름을 담는다. 대체 renderer 없음, 조용한 대체 없음.
5. 판정은 숫자다: `surface.composition`, `layout.alignment`, 서비스·사이드카가 발행하는 state,
   관측용 `window.snapshot`.
6. 커서 모양·표시·위치·깜빡임 정책·현재 단계는 엔진과 renderer 의 `surface.state`에서 온다.
   이 플러그인은 그 상태를 공개 터미널 DOM과 status event에 투영한다. CSI를 파싱하거나 커서
   타이머를 만들지 않는다.
7. 선언은 명시적인 `light|dark` base theme을 포함한다. Host theme epoch는 `surface.theme`
   command 하나를 보낸다. 완전한 `surface.state` 응답만 `themeStatus`가 되며 unthemed fallback과
   polling 경로는 없다. Text wait는 state event를 구독하고 deadline timeout 하나만 사용한다.
8. 가시성 소유자는 둘이다. Workbench pane 가시성은 intrinsic이며 `data-native-visible`에 쓰는
   유일한 값이다. Core workspace, tab, overlay presentation은 host 조상에 남고 Plugin 선언에
   중복하지 않는다. Effective visibility는 render 작업을 결정하고 host dim은 native alpha를
   결정한다.

`shownlog` 진단 명령은 pane별 surface frame event, 성공한 state read, 실패한 read의 횟수와
마지막 payload를 보고한다. state 전달 실패는 이름과 함께 기록하며 timer나 retry loop로 대체하지
않는다.

## 이 플러그인이 소비하는 이음매

- `soksak-spec-sidecar-surface` — IOSurface 링, 채널, `surface.*` 명령.
- `soksak-spec-plugin-terminal` — 모든 터미널 구현이 답하는 표준 명령·노드·status.
- 공유 플러그인 kit 의 surface 배달 모드 — 프레임 루프 없는 분할·복원·status·명령 라우팅.

## 검증

```sh
make verify REGISTRY=http://host:port/
```

성능 수치는 단계가 끝날 때마다 [PERF.md](PERF.md) 에 남는다. 목표치는 코드 전에 적고 뒤에 낮추지
않는다.
