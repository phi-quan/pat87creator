export const ACCESS_TOKEN_COOKIE_NAME = 'sb-access-token';

const ONE_WEEK_SECONDS = 60 * 60 * 24 * 7;

export function setAccessTokenCookie(token: string): void {
  document.cookie = `${ACCESS_TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${ONE_WEEK_SECONDS}; SameSite=Lax`;
}

export function clearAccessTokenCookie(): void {
  document.cookie = `${ACCESS_TOKEN_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
}
