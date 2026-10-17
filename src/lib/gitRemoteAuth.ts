/**
 * HTTPS Git auth for any host.
 * SSH URLs are left unchanged — host keys / deploy keys handle auth.
 */

export type GitRemoteUserinfo = {
  /** Clean clone URL without userinfo */
  cleanUrl: string;
  username?: string;
  token?: string;
};

/** True when the URL looks like git+SSH (no embedded HTTPS userinfo). */
export function isSshGitUrl(url: string): boolean {
  const t = url.trim();
  return /^git@/i.test(t) || /^ssh:\/\//i.test(t);
}

/**
 * Peel username/password out of an HTTPS Git URL.
 * Returns the URL without credentials plus any extracted userinfo.
 */
export function peelGitRemoteUserinfo(url: string): GitRemoteUserinfo {
  const trimmed = url.trim();
  if (!trimmed || isSshGitUrl(trimmed) || !/^https?:\/\//i.test(trimmed)) {
    return { cleanUrl: trimmed };
  }
  try {
    const u = new URL(trimmed);
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const token = u.password ? decodeURIComponent(u.password) : undefined;
    u.username = '';
    u.password = '';
    return {
      cleanUrl: u.toString(),
      username: username || undefined,
      token: token || undefined,
    };
  } catch {
    const m = trimmed.match(/^(https?:\/\/)([^/@]+)(:([^/@]*))?@(.+)$/i);
    if (!m) return { cleanUrl: trimmed };
    return {
      cleanUrl: `${m[1]}${m[5]}`,
      username: decodeURIComponent(m[2]),
      token: m[4] != null && m[4] !== '' ? decodeURIComponent(m[4]) : undefined,
    };
  }
}

/**
 * Build an authenticated HTTPS remote for a single git invocation.
 * Username defaults to `git` (accepted by most hosts when the password is a PAT/token).
 * Operators can set username explicitly (e.g. GitLab `oauth2`, Bitbucket `x-token-auth`).
 */
export function authenticatedGitRemoteUrl(
  cleanUrl: string,
  auth: { username?: string; token?: string } | null | undefined
): string {
  const trimmed = cleanUrl.trim();
  if (!trimmed || !auth?.token || isSshGitUrl(trimmed) || !/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  try {
    const u = new URL(trimmed);
    u.username = auth.username?.trim() || 'git';
    u.password = auth.token;
    return u.toString();
  } catch {
    return trimmed;
  }
}

/** Redact userinfo for API responses / logs. */
export function redactGitRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url);
      if (u.username || u.password) {
        u.username = u.username ? '***' : '';
        u.password = u.password ? '***' : '';
        return u.toString();
      }
      return url;
    }
    return url;
  } catch {
    return url.replace(/\/\/([^/@]+)(:[^/@]*)?@/, '//***:***@');
  }
}
