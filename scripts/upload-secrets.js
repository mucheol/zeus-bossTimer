import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// 비공개 로컬 키를 표준 입력으로 Cloudflare에 전달합니다.
function uploadSecrets() {
  const text = readFileSync('.dev.vars', 'utf8');
  const secrets = Object.fromEntries([...text.matchAll(/^(VAPID_[A-Z_]+)="([^"]+)"$/gm)].map(match => [match[1], match[2]]));
  if (!secrets.VAPID_PUBLIC_KEY || !secrets.VAPID_PRIVATE_KEY || !secrets.VAPID_SUBJECT) throw new Error('.dev.vars의 VAPID 설정이 필요합니다.');
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
}

uploadSecrets();
