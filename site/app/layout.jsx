export const metadata = { title: "Your site" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", color: "#1a1a1a", background: "#fff" }}>{children}</body>
    </html>
  );
}
