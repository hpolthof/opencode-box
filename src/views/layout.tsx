import type { FC, PropsWithChildren } from "hono/jsx";
import { BASE_STYLES, FAVICON_HREF, Logo } from "./theme";

const NAV_LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/playground", label: "Playground" },
  { href: "/admin/keys", label: "Keys" },
  { href: "/admin/requests", label: "Requests" },
  { href: "/admin/providers", label: "Providers" },
  { href: "/admin/models", label: "Models" },
  { href: "/admin/aliases", label: "Aliases" },
  { href: "/admin/terminal", label: "Terminal" },
  { href: "/admin/maintenance", label: "Maintenance" },
];

export const Layout: FC<PropsWithChildren<{ title: string; subtitle?: string }>> = ({ title, subtitle, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} · opencode-box admin</title>
        <link rel="icon" href={FAVICON_HREF} />
        <style dangerouslySetInnerHTML={{ __html: BASE_STYLES }}></style>
      </head>
      <body>
        <nav>
          <Logo />
          <div class="nav-links">
            {NAV_LINKS.map((link) => (
              <a href={link.href} class={`nav-link${link.label === title ? " active" : ""}`}>
                {link.label}
              </a>
            ))}
          </div>
          <a href="/admin/logout" class="logout-link">
            Logout
          </a>
        </nav>
        <main>
          <div class="page-header">
            <h1>{title}</h1>
            {subtitle && <p class="page-subtitle">{subtitle}</p>}
          </div>
          {children}
        </main>
      </body>
    </html>
  );
};
