import { describe, expect, it } from 'vitest';
import {
  authenticatedGitRemoteUrl,
  isSshGitUrl,
  peelGitRemoteUserinfo,
  redactGitRemoteUrl,
} from '../src/lib/gitRemoteAuth';

describe('gitRemoteAuth', () => {
  it('detects SSH remotes', () => {
    expect(isSshGitUrl('git@gitlab.example.com:org/repo.git')).toBe(true);
    expect(isSshGitUrl('ssh://git@bitbucket.org/org/repo.git')).toBe(true);
    expect(isSshGitUrl('https://github.com/org/repo.git')).toBe(false);
  });

  it('peels HTTPS userinfo for any host', () => {
    const peeled = peelGitRemoteUserinfo(
      'https://oauth2:glpat-secret@gitlab.example.com/org/intent.git'
    );
    expect(peeled.cleanUrl).toBe('https://gitlab.example.com/org/intent.git');
    expect(peeled.username).toBe('oauth2');
    expect(peeled.token).toBe('glpat-secret');
  });

  it('builds authenticated remotes with default username git', () => {
    const auth = authenticatedGitRemoteUrl('https://git.example.com/a/b.git', {
      token: 'tok',
    });
    expect(auth).toBe('https://git:tok@git.example.com/a/b.git');
  });

  it('preserves explicit username (GitLab/Bitbucket style)', () => {
    const auth = authenticatedGitRemoteUrl('https://bitbucket.org/w/r.git', {
      username: 'x-token-auth',
      token: 'bb-tok',
    });
    expect(auth).toContain('x-token-auth');
    expect(auth).toContain('bb-tok');
  });

  it('leaves SSH URLs alone when applying token', () => {
    const ssh = 'git@gitea.example:org/repo.git';
    expect(authenticatedGitRemoteUrl(ssh, { token: 'x' })).toBe(ssh);
  });

  it('redacts userinfo', () => {
    expect(redactGitRemoteUrl('https://u:p@github.com/o/r.git')).toBe(
      'https://***:***@github.com/o/r.git'
    );
  });
});
