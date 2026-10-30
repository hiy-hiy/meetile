import type { ReactNode } from 'react';
import './style.css';
export const metadata = {
  title: 'puzzle-sns｜通報の確認',
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
