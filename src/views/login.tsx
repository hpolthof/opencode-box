import type { FC } from "hono/jsx";
import { BASE_STYLES, Logo } from "./theme";

export const Login: FC<{ error?: string }> = ({ error }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Login · opencode-box admin</title>
        <style dangerouslySetInnerHTML={{ __html: BASE_STYLES }}></style>
      </head>
      <body>
        <div class="login-shell">
          <form class="login-card" method="post" action="/admin/login">
            <Logo href="/admin/login" />
            <p class="tagline">Sign in to manage keys, providers and usage.</p>
            {error && <div class="banner error">{error}</div>}
            <input type="password" name="password" placeholder="Admin password" autofocus required />
            <button type="submit">Log in</button>
          </form>
        </div>
      </body>
    </html>
  );
};
