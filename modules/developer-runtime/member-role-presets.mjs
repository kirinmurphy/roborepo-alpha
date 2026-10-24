// The name, port, and title hints that classify a running member and rank it within its role. Kept
// as plain tables, apart from the logic that reads them (member-role.mjs), so teaching the page that
// another tool exists is a one-line change here.
//
// Names are matched as whole tokens (see nameTokens in member-role.mjs), never as substrings, so a
// short entry like `meta` or `auth` cannot claim `metabase` or `oauth-demo`. Titles are matched as
// case-insensitive substrings, because a page title is prose rather than an identifier.

// Infrastructure a person does not open in a browser, even when it answers HTTP (Kong's gateway
// returns a JSON 404 at its root). Most Supabase services appear here by name: the Supabase CLI sets
// no Compose service label, so its containers are named `supabase_<service>_<project>`.
export const SERVICE_PRESETS = Object.freeze({
  names: Object.freeze(["db", "postgres", "redis", "kong", "rest", "realtime", "auth", "storage", "meta"]),
  // Supabase API gateway and database.
  ports: Object.freeze([54321, 54322]),
});

// Human-readable developer tooling: worth a click now and then, but never the product itself.
export const TOOLING_PRESETS = Object.freeze({
  names: Object.freeze(["storybook", "studio", "mailpit", "mailhog", "inbucket", "ngrok"]),
  titles: Object.freeze([
    "storybook",
    "supabase studio",
    "mailpit",
    "mailhog",
    "prisma studio",
    "drizzle studio",
    "swagger ui",
    "ngrok",
    "traefik",
  ]),
  // Storybook, Prisma Studio, Mailpit/MailHog, the ngrok inspector, Drizzle Studio, Supabase Studio.
  ports: Object.freeze([6006, 5555, 8025, 4040, 4983, 54323]),
});

// Tie-breaker hints inside a role. Names mostly decide between Compose services and user-named
// apps, whose names are chosen rather than taken from a process command.
export const APP_LIKE_NAMES = Object.freeze(["web", "app", "frontend", "client", "site"]);

// Default dev-server ports: Next/Express/Rails, CRA's fallback, Angular, Astro, Vite, Django/uvicorn,
// and the generic alternate HTTP port.
export const COMMON_APP_PORTS = Object.freeze([3000, 3001, 4200, 4321, 5173, 8000, 8080]);
