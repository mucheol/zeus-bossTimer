# 에뮬레이터 확인용 APK

배포된 PWA를 Google Trusted Web Activity로 여는 테스트 APK입니다. 화면과 공통 데이터는 웹 배포를 그대로 사용하며 APK 안에 복사하지 않습니다. iPhone과 일반 사용자는 기존 홈 화면 설치 방식도 계속 사용할 수 있습니다.

Android Studio에서 이 폴더를 엽니다. JDK 17 이상, Android SDK 37.0, Build Tools 36.0.0, Android 7 이상과 Chrome이 있는 에뮬레이터가 필요합니다.

최초 한 번 프로젝트 전용 테스트 키를 생성합니다. 키는 Git에 올리지 않으며 공개한 인증서 지문만 웹의 `/.well-known/assetlinks.json`에 연결합니다. 기존 키를 교체하면 지문도 다시 게시해야 합니다.

```powershell
New-Item -ItemType Directory -Force .signing
keytool -genkeypair -keystore .signing/preview.keystore -storepass android -keypass android -alias zeus-preview -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=Zeus Preview'
./gradlew.bat assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.mucheol.zeus.preview/com.google.androidbrowserhelper.trusted.LauncherActivity
```

표시 이름은 **제우스**, 현재 versionCode는 2입니다. Android 13 이상 알림 권한과 Android Browser Helper의 알림 위임 서비스·권한 요청 화면을 포함합니다. Chrome 웹 알림은 앱의 알림 채널로 전달하며 소리·진동은 기기 설정을 따릅니다. 기존 APK는 같은 서명으로 한 번 업데이트 설치해야 이 변경을 사용할 수 있습니다. 알림 위임은 Chrome이 필요할 때 호출하며 상시 실행 서비스는 추가하지 않습니다.

이 APK는 프로젝트 전용 테스트 서명이며 스토어 제출·배포용 서명 관리는 포함하지 않습니다. Android·iPhone 실기기의 수신과 배터리 사용량은 별도 확인이 필요합니다. 웹 화면·보스 시간의 후속 수정은 웹 배포만으로 반영됩니다.
