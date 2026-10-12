// Default free hosted server, offered as an opt-in choice on the setup
// screens and in Settings — never forced. Overridable at build time via
// VITE_DEFAULT_SERVER so forks point at their own instance. The trailing
// slash is stripped so the value survives every URL normalization in the
// app (Login/Register/Settings compare exact strings).
const FALLBACK_FREE_SERVER = "https://relay-hst.tdvorak.dev";

export const FREE_SERVER_URL: string =
  import.meta.env.VITE_DEFAULT_SERVER?.trim().replace(/\/+$/, "") ||
  FALLBACK_FREE_SERVER;
