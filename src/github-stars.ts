export const GITHUB_REPOSITORY_URL = "https://github.com/nickpeanutai/pixelate";

const REPOSITORY_API_URL = "https://api.github.com/repos/nickpeanutai/pixelate";
const CACHE_KEY = "pixelate.github-stars.v1";
const CACHE_TTL_MS = 60 * 60 * 1_000;

interface CachedStars {
  count: number;
  expiresAt: number;
}

export function readCachedGitHubStars(): number | undefined {
  const cached = readCache();
  return cached?.count;
}

export async function fetchGitHubStars(): Promise<number | undefined> {
  const cached = readCache();
  if (cached && cached.expiresAt > Date.now()) return cached.count;

  try {
    const response = await fetch(REPOSITORY_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return cached?.count;
    const count = parseStarCount((await response.json()) as unknown);
    if (count === undefined) return cached?.count;
    writeCache({ count, expiresAt: Date.now() + CACHE_TTL_MS });
    return count;
  } catch {
    return cached?.count;
  }
}

export function parseStarCount(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("stargazers_count" in value)) return undefined;
  const count = (value as { stargazers_count?: unknown }).stargazers_count;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function formatStarCount(count: number): string {
  if (count < 1_000) return String(count);
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

function readCache(): CachedStars | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Partial<CachedStars> | null;
    if (!value || !Number.isSafeInteger(value.count) || Number(value.count) < 0 || !Number.isFinite(value.expiresAt)) return undefined;
    return { count: Number(value.count), expiresAt: Number(value.expiresAt) };
  } catch {
    return undefined;
  }
}

function writeCache(value: CachedStars): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private or restricted browsing contexts.
  }
}
