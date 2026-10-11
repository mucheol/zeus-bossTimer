# GitHub 배포 준비

프로젝트 폴더 전체가 저장소 루트가 됩니다. 저장소 이름 후보는 `zeus-boss-timer`입니다. 현재 앱의 업데이트 클라이언트는 공개 GitHub Releases 파일을 사용합니다. 소스를 비공개로 유지하려면 APK와 latest.json만 제공하는 별도 공개 저장소 주소를 사용하세요.

## 첫 배포

1. 새 저장소에 이 소스를 올립니다. 키스토어·암호·개인 서명 백업은 소스에 포함하지 않습니다.
2. `UpdateConfig.java`의 `REPOSITORY`를 실제 공개 업데이트 저장소의 `owner/repo`로 설정합니다.
3. 기존과 같은 서명 키로 새 버전을 빌드합니다. 이미 설치한 앱보다 versionCode가 커야 합니다.
4. `tools/release-info.ps1`로 latest.json을 생성합니다. 버전 태그는 `v`와 manifest의 versionName을 합친 값입니다.
5. 해당 태그의 GitHub Release에 `zeus-boss-timer.apk`, `latest.json`을 첨부합니다.
6. 이 주소가 연결된 APK부터 친구들에게 전달합니다. 저장소 주소가 비어 있는 이전 APK는 연결된 새 APK를 직접 설치해야 합니다.

## 코드 수정 후 자동 빌드

`release-workflow.yml.example`은 자동 배포 준비 파일입니다. 서명 설정 전에는 활성화하지 않습니다.

1. 개인 서명 키를 GitHub에 맡길지 결정합니다. 키는 공개 소스나 릴리스 파일로 올리지 않습니다.
2. 맡기기로 한 경우, 해당 저장소의 **Settings → Secrets and variables → Actions**에 `ZEUS_KEYSTORE_BASE64`와 `ZEUS_KEYSTORE_PASSWORD`를 저장합니다. 첫 배포와 같은 키와 암호를 사용합니다.
3. 예제 파일을 `.github/workflows/release.yml`로 복사합니다.
4. main에 코드가 올라오면 테스트·서명 빌드·릴리스 게시를 수행합니다. 워크플로 실행 기록에서 성공 여부를 확인합니다.

앱은 실행 시 하루에 한 번 또는 ‘새 버전 확인’을 눌렀을 때 새 릴리스를 조회합니다. 안드로이드의 업데이트 설치 확인은 사용자가 눌러야 합니다. GitHub Actions 실행이 실패하면 새 릴리스는 게시되지 않습니다. 위 자동 배포는 아직 실제 GitHub에서 실행 검증되지 않았습니다.
