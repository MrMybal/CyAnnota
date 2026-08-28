import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CyAnnota — Interface corrections',
  description: 'Annotate interfaces, images, and videos, then export a correction package.',
  icons: { icon: '/cyannota-logo.png', apple: '/cyannota-logo.png' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
