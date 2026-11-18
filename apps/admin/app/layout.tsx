import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Midotel Admin',
  description: 'Manage your hotel website, rooms and bookings',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
