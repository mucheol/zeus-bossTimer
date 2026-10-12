# Cloudflare 무료 배포

현재 사용 주소: https://zeus-boss-timer.zeus-boss-timer.workers.dev

## 최초 설정

Cloudflare 계정의 이메일 인증을 마친 뒤 실행합니다. Workers Free를 사용하며 유료 플랜 변경은 하지 않습니다.

```powershell
npm ci
npm exec wrangler -- login
npm exec wrangler -- d1 create zeus-boss-timer
npm exec wrangler -- queues create zeus-boss-push
```

이미 만들어진 리소스가 있으면 다시 생성하지 않습니다. `wrangler.jsonc`의 `database_id`를 생성 결과로 채웁니다. 큐는 기기마다 발송을 분리하고, Cron은 매분 발송 대상을 큐로 넘깁니다.

```powershell
npm run keys
npm run db:remote
npm run deploy
node scripts/upload-secrets.js
```

`.dev.vars`에는 VAPID 공개키·비밀키·연락 가능한 HTTPS 주소가 있습니다. 관리자 비밀번호는 같은 파일에 `ADMIN_PASSWORD="직접 정한 값"`으로 추가합니다. 비밀값은 `upload-secrets.js`가 표준 입력으로 Cloudflare secret에 전달하며 저장소나 명령 출력에 노출하지 않습니다. 최초 키를 보관하고, 이후 배포 때 새로 생성하지 않습니다. 키를 변경하면 기존 기기는 알림 연결을 다시 해야 합니다.

## 수정 후 배포

```powershell
npm run deploy
```

스키마가 추가된 버전은 먼저 `npm run db:remote`를 실행합니다. 관리자 시간 수정은 배포 없이 D1에 즉시 저장되며 열린 다른 기기는 최대 15초 뒤 또는 복귀 시 확인합니다. 푸시 예약은 아래의 분 단위 갱신 규칙을 따릅니다.

공통 자료를 수정할 때는 `public/data/catalog.json`의 `revision`도 변경합니다. 새 관측은 같은 회차인지 확인하고 원본 기록과 이미지도 보관합니다. 배포 전 데이터 검사·시간 계산·D1 검사와 번들 검사를 실행합니다. 화면 변경 시 캐시 버전이 자동 갱신됩니다.

자료 변경 후 기존 기기 예약은 매분 최대 5기기씩 갱신합니다. 새 버전이 반영되지 않은 기기의 예전 예약은 발송하지 않습니다. 기기가 많으면 자료 변경 직후 예약 갱신이 수분 걸릴 수 있습니다. 한 번에 최대 100개 발송 대상을 큐로 보냅니다. 지난 알림은 몰아 보내지 않습니다.

알림 전달 직전 취소·만료·구독 유효성을 확인합니다. 공급자가 404·410을 반환하면 구독을 제거합니다. 일시 장애는 최대 4번 시도하고, 예정 시각 이후 2분이 지난 알림은 폐기합니다. 사전 알림은 출현 시각 이후 폐기합니다. 이미 전송이 시작된 알림은 선택 해제 직후라도 도착할 수 있습니다.

서버 만료와 짧은 TTL로 늦은 전송을 제한합니다. 수신 후 기기에서 처리 자체가 지연된 경우에는 지난 사전 알림 대신 ‘지연된 알림’ 안내를 표시합니다. Safari는 수신한 푸시에 사용자 알림을 표시해야 구독이 유지됩니다. [WebKit 수신 규칙](https://webkit.org/blog/12945/meet-web-push/).

## 무료 사용량

- 정적 파일 요청은 무료·무제한입니다.
- Workers Free는 동적 요청 100,000회/일, 기본 CPU 한도가 있습니다.
- D1 Free는 5백만 행 읽기/일, 10만 행 쓰기/일, 총 5GB 저장 한도입니다.
- Queues Free는 10,000 작업/일입니다. 일반적으로 알림 1개는 쓰기·읽기·삭제 3작업을 사용하므로 재시도 전 약 3,333건/일입니다.
- 모든 기기의 알림 개수와 테스트·재시도를 합산합니다. 무료 한도 초과 시 중단될 수 있습니다. 큰 규모 배포 전에 대시보드에서 실제 CPU와 사용량을 확인합니다.
- 이미 계정이 유료 플랜이면 위 무료 전용 상한이 적용되지 않을 수 있으므로 계정 플랜을 확인합니다. 프로젝트는 유료 플랜을 활성화하지 않습니다.

[Workers 한도](https://developers.cloudflare.com/workers/platform/limits/), [정적 파일 과금](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [D1 과금](https://developers.cloudflare.com/d1/platform/pricing/), [Queues 과금](https://developers.cloudflare.com/queues/platform/pricing/).

## 기기 수신 확인

배포 주소를 Android와 iPhone에서 홈 화면에 추가하고 알림을 연결합니다. 10초 테스트를 누른 뒤 화면을 잠그고 확인합니다. 진동·소리·배너는 브라우저와 운영체제의 사용자 설정을 따르며 집중 모드를 우회하지 않습니다.

iPhone은 iOS 16.4 이상과 홈 화면 설치가 필요합니다. [Apple 안내](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).

Cron은 분 단위이므로 정각은 예약 기준이며 초 단위 도착은 보장하지 않습니다. 일반 보스는 최신 기준 이후 리스폰을 반복 추정합니다. 미래 3일치 예약을 만들고 매일 갱신하며 지난 알림은 제외합니다. 관리자 수정값과 반복 추정은 실제 관측 학습에 포함하지 않습니다.
