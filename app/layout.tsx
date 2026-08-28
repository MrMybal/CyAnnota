import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CyAnnota — Corrections d’interface',
  description: 'Annotez vos interfaces et exportez un brief de corrections prêt à envoyer.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
