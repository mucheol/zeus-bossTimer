import { existsSync, writeFileSync } from 'node:fs';

// 개발용 VAPID 키를 만들고 비공개 파일에만 기록합니다.
async function createKeys() {
  if (existsSync('.dev.vars')) throw new Error('.dev.vars가 이미 있습니다. 기존 키를 유지합니다.');
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = Buffer.from(raw).toString('base64url');
  writeFileSync('.dev.vars', `VAPID_PUBLIC_KEY="${publicKey}"\nVAPID_PRIVATE_KEY="${jwk.d}"\nVAPID_SUBJECT="https://github.com/mucheol/zeus-bossTimer"\n`, { mode: 0o600 });
  console.log('VAPID 키 생성 완료: .dev.vars (Git 제외). 비밀키를 출력하지 않았습니다.');
}

await createKeys();
