import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { ADMIN_SESSION_COOKIE, checkPassword, requireAdmin, signSession } from "../../auth/adminSession";
import { Login } from "../../views/login";
import { dashboardRouter } from "./dashboard";
import { keysRouter } from "./keys";
import { requestsLogRouter } from "./requestsLog";
import { providersRouter } from "./providers";
import { playgroundRouter } from "./playground";
import { modelsRouter } from "./models";
import { terminalRouter } from "./terminal";
import { maintenanceRouter } from "./maintenance";

export const adminRouter = new Hono();

// Public routes — must be registered before requireAdmin is applied.
adminRouter.get("/login", (c) => {
  return c.html(Login({}) as string);
});

adminRouter.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const password = typeof body.password === "string" ? body.password : "";

  if (!checkPassword(password)) {
    return c.html(Login({ error: "Incorrect password" }) as string, 401);
  }

  setCookie(c, ADMIN_SESSION_COOKIE, signSession(), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
  return c.redirect("/admin", 302);
});

adminRouter.get("/logout", (c) => {
  deleteCookie(c, ADMIN_SESSION_COOKIE, { path: "/" });
  return c.redirect("/admin/login", 302);
});

// Everything registered after this point requires a valid admin session.
adminRouter.use("*", requireAdmin);

adminRouter.route("/", dashboardRouter);
adminRouter.route("/", keysRouter);
adminRouter.route("/", requestsLogRouter);
adminRouter.route("/", providersRouter);
adminRouter.route("/", playgroundRouter);
adminRouter.route("/", modelsRouter);
adminRouter.route("/", terminalRouter);
adminRouter.route("/", maintenanceRouter);
