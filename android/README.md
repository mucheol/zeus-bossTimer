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

이 APK는 테스트 서명이며 스토어 제출·배포용 서명 관리는 포함하지 않습니다. 푸시는 Chrome의 웹 알림 권한과 기기 설정을 따릅니다. 네이티브 알림 전달 서비스는 별도로 추가하지 않았습니다.
