import { Console } from './console';
import { readAdminConfig } from '../server/config';
export const dynamic = 'force-dynamic';
export default function Page() {
  try {
    const config = readAdminConfig();
    return <Console mode={config.mode} web={config.web} />;
  } catch {
    return (
      <main>
        <p className="eyebrow">puzzle-sns / ADMIN</p>
        <h1>管理画面を準備しています</h1>
        <p>認証と接続先の設定が完了するまで利用できません。</p>
      </main>
    );
  }
}
