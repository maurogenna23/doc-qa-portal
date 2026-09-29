import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Doc Q&A',
  description: 'Ask questions against your own documents, answered with citations.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="masthead">
            <Link href="/" className="wordmark">
              Doc Q&amp;A
            </Link>
            <nav className="nav">
              <Link href="/">Ask</Link>
              <Link href="/docs">Documents</Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
