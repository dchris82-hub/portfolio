# GitHub Pages + Supabase 배포

블로그 저장소와 도메인은 그대로 유지합니다. 이 앱은 별도의 `portfolio` 저장소에서 배포합니다. `deploy-config.json`에는 사용자가 제공한 공개용 URL과 publishable key만 있습니다. Secret key, service_role, DB 비밀번호는 앱 코드나 GitHub 설정에 넣지 않습니다.

## 1. 데이터베이스 준비

Supabase SQL Editor에서 `setup.sql`을 실행합니다. 이 파일은 테이블, RLS 정책, 원자적 거래 처리 함수를 만들지만 개인 자산이나 로그인 계정을 포함하지 않습니다. 사용자별 조회와 수정 권한은 다음과 같습니다.

- 익명 사용자: 자산 조회/수정 불가
- 회원가입만 한 제3자: 자산 조회/수정 불가
- 관리자가 지정한 두 계정: 가족 자산 공동 조회, 본인 계좌의 거래만 입력
- 두 계정 모두: 공동 시세와 환율 갱신, 오늘의 가족 총자산 기록
- 앱에서 테이블 직접 수정 또는 회원 추가: 불가

데이터는 RLS를 켠 테이블에 저장하며, 조회에 필요한 최소한의 `SELECT` 권한과 검증된 RPC 실행 권한만 줍니다. 변경 함수는 인증된 사용자 ID로 소유자를 결정하고, 행 잠금 및 버전 비교로 동시 수정을 보호합니다. 클라이언트가 보낸 owner, 계산 결과, 잔고는 신뢰하지 않습니다.

개인 데이터 가져오기는 관리자가 SQL Editor에서 별도로 수행합니다. 이번 작업 공간의 `/workspace/portfolio-data/supabase-setup.sql`은 `setup.sql`과 기존 seed의 초기 INSERT를 합친 **개인용 파일**입니다. GitHub에 올리지 마세요. 재실행해도 기존 잔고를 덮어쓰지 않습니다. 이미 운영 중인 데이터를 초기화하거나 다른 seed로 자동 대체하지 않습니다.

## 2. 두 로그인 계정 만들기

Supabase의 Authentication → Users에서 두 이메일 계정을 만들고 이메일 확인을 완료합니다. 직접 사용자가 관리하는 이메일과 비밀번호를 사용하며, 비밀번호는 채팅이나 SQL 파일에 넣지 않습니다. 로그인 방식은 이메일 + 비밀번호입니다. 일반 사용자 가입은 Authentication 설정에서 비활성화하는 것을 권장하며, 제3자가 가입하더라도 아래 가족 등록 전에는 데이터 접근이 차단됩니다.

SQL Editor에서 각 이메일과 엑셀의 정확한 소유자 이름을 매핑합니다. 다음은 자리표시자이며 그대로 실행하지 마세요.

```sql
select portfolio_private.add_member('FIRST_EMAIL', 'FIRST_EXCEL_OWNER');
select portfolio_private.add_member('SECOND_EMAIL', 'SECOND_EXCEL_OWNER');
```

이 등록 함수는 API에 노출되지 않는 관리용 스키마에 있고, 앱 사용자는 실행할 수 없습니다. 등록된 소유자와 이메일을 확인하려면 관리자가 다음을 실행합니다.

```sql
select m.owner, u.email
from public.portfolio_members m join auth.users u on u.id = m.user_id;
```

## 3. 정적 사이트 만들기와 배포

```sh
npm ci
npm run check
npm test
npm run build:pages
```

정적 결과는 `site/`에 생성됩니다. 빌더는 정해진 공개 파일만 복사합니다. 개인 Excel, seed, DB, SQL 가져오기 파일, `preview.html`은 포함하지 않습니다. GitHub Pages 프로젝트 하위 경로를 지원하도록 스크립트·스타일·매니페스트 경로를 상대 경로로 만듭니다.

GitHub 저장소 Settings → Pages에서 Source를 GitHub Actions로 선택합니다. `.github/workflows/pages.yml`은 main 브랜치에 push되면 검사 후 **site만** 배포합니다. 이 작업은 현재까지 원격 저장소에 push하거나 사이트를 실제 게시하지 않았습니다. 배포 후 Pages가 표시한 실제 주소로 접속합니다.

## 4. 실제 사용 전 확인

두 이메일로 각각 로그인하여 가족 자산이 보이는지, 본인 거래 저장과 다른 기기의 갱신이 되는지 확인합니다. 로그아웃하면 조회가 차단되어야 합니다. 미등록 계정은 자산을 볼 수 없어야 합니다. 아래 자동 기록 설정 전에는 현재가와 환율을 수동 입력합니다. 아이폰 Safari에서 HTTPS 주소를 연 뒤 홈 화면에 추가합니다.

내보내기는 Supabase에서 조회한 최신 자산 JSON을 내려받습니다. Supabase Free의 현재 사용 한도·일시 중지·백업 정책은 운영 전에 서비스 대시보드에서 확인하세요. 주기적으로 JSON을 안전하게 보관하고, 운영용 계정 복구 및 백업 복원 절차를 검증하세요. 비밀번호 재설정 이메일을 사용하려면 Supabase의 Site URL과 허용된 리다이렉트 주소, 발송 설정도 실제 앱 주소에 맞춰야 합니다.

로컬 검증: PGlite(PostgreSQL 엔진)에서 설정 SQL, RLS, 익명/외부인 차단, 본인 거래 제한, 수수료 통화, 잔고, 버전 충돌, 설정 재실행을 검사합니다. 브라우저 연결 코드는 별도 테스트로 인증·갱신·로그아웃·권한 오류 처리를 검사합니다. 실제 Supabase 프로젝트에 SQL 적용/계정 등록 및 실기기 검증은 별도 완료가 필요합니다.

## 매일 오전 7시 30분 자동 기록

Supabase SQL Editor에서 최신 `setup.sql` 다음에 `daily-snapshot.sql`을 실행합니다. 기존 자산과 계정을 삭제하거나 초기 seed를 재적용하지 않습니다. 작업 공간에는 두 파일을 합친 `/workspace/portfolio-data/enable-daily-snapshot.sql`을 제공합니다. 원본 엑셀이나 seed는 포함되지 않습니다.

- Supabase의 pg_cron과 pg_net을 사용합니다. 브라우저나 GitHub Actions의 지연 가능한 예약 실행에 의존하지 않습니다. 별도의 API 키나 유료 시세 구독은 설정하지 않습니다.
- Cron의 `30 22 * * *`(UTC)는 한국시간 매일 07:30입니다. 해당 시점의 보유 수량/현금을 고정하고 주가와 USD/KRW를 조회합니다. 응답은 다음 분의 처리 작업에서 반영되므로 화면에는 보통 1~3분 후 나타납니다.
- 시세 제공처는 Yahoo Finance 공개 chart 응답입니다. 국내 `KRX:코드`는 `.KS`를 조회하고 해당 종목이 없을 때 `.KQ`를 시도합니다. 미국 종목은 해당 Yahoo 심볼을, USD/KRW는 `KRW=X`를 사용합니다. 종목과 통화가 일치하는지 검증합니다.
- 자동 기록 시점까지 완료된 1분봉을 선택하며 미래 시세를 사용하지 않습니다. 유효한 분봉이 없으면 기준 시각 이전의 정규장 최근 가격을 확인합니다. 휴장일에는 제공처의 최근 유효 시세를 사용하고 실제 기준 시각을 기록합니다. 이는 은행의 실제 환전 적용 환율이나 체결 가격이 아닙니다.
- 보유 수량이 있는 모든 종목과 환율이 조회되어야 저장합니다. 일부 조회 실패는 최대 세 번 재시도하며, 끝내 실패하면 과거 수동 가격으로 성공 기록을 만들지 않고 앱에 실패 상태를 표시합니다. 제공처 장애·제한·미지원 종목은 자동 기록을 막을 수 있습니다.
- 시세가 도착하는 동안 발생한 거래는 07:30 기록에 들어가지 않고 현재 잔고에서 사라지지도 않습니다. 07:30 이후의 수동 가격 수정은 자동 응답이 덮어쓰지 않습니다. 완료된 자동 기록은 수동 ‘오늘 기록’ 버튼으로 교체하지 않습니다.
- 설치 시에는 연결 검사만 실행합니다. 검사는 자산의 현재가·환율·추이를 바꾸지 않습니다. 앱에서 ‘시세 연결 검사 완료’가 나타나야 외부 시세가 실제 프로젝트에서 조회된 것입니다. 로컬 테스트의 HTTP/cron은 모의 경계이므로 실제 네트워크나 예약 실행 검증을 대신하지 않습니다.

운영 확인은 Supabase SQL Editor에서 다음을 실행합니다(개인 자산/비밀번호를 출력하지 않음).

```sql
select jobname,schedule,active from cron.job
where jobname in ('portfolio-daily-kst-0730','portfolio-settle-quotes');
select id,kind,target_date,status,message from portfolio_private.snapshot_runs
order by id desc limit 5;
```

자동 기록을 일시 중지하려면 `select cron.alter_job(job_id := (select jobid from cron.job where jobname='portfolio-daily-kst-0730'), active := false);`를 관리자 SQL Editor에서 실행합니다. Supabase 프로젝트가 중지되면 작업도 실행되지 않으며 누락일을 임의 가격으로 채우지 않습니다. 무료 프로젝트의 일시 중지 정책은 Supabase의 현재 요금제 안내를 확인하세요.
