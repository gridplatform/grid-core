import fs from 'fs';
import path from 'path';
import {
  archiveMirrorHasS3Endpoint,
  resolveTfBackendMode as resolveMode,
  type TfBackendMode,
} from './lib/tfBackend';
import { isSshGitUrl, peelGitRemoteUserinfo } from './lib/gitRemoteAuth';

/**
 * Production boot gate (`npm run prod` / `npm start`).
 * Hard requirements — no escape flags. Use `npm run dev` for local work.
 */

export type { TfBackendMode };

type Finding = {
  key: string;
  found: string;
  expect: string;
  fix?: string;
};

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

function display(value: string | undefined, empty = '(not set)'): string {
  const v = (value || '').trim();
  return v || empty;
}

export function resolveTfBackendMode(): TfBackendMode {
  return resolveMode();
}
export function isGitRemoteBank(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (/^git::/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^git@[^:]+:/.test(v)) return true;
  return false;
}

/** Released module-bank tags: v0.1.0, v0.1.0-lts, … */
export function isReleaseModuleBankRef(ref: string | undefined): boolean {
  if (!ref) return false;
  return /^v\d+\.\d+\.\d+(-[\w.]+)?$/i.test(ref.trim());
}

export function tfBackendConfigProblems(): string[] {
  // Kept for assertTfBackendConfigOrThrow (incomplete remote backend).
  return collectTfFindings().map(
    (f) => `${f.key}: found ${f.found} — ${f.expect}`
  );
}

function collectTfFindings(): Finding[] {
  const mode = resolveTfBackendMode();
  const foundBackend = display(process.env.GRID_TF_BACKEND, '(unset → local)');
  const out: Finding[] = [];

  if (mode === 'local') {
    out.push({
      key: 'GRID_TF_BACKEND',
      found: foundBackend,
      expect: 's3 | gcs | azurerm | oci | oss | cos | s3compat',
      fix: 'GRID_TF_BACKEND=s3',
    });
    return out;
  }

  if (mode === 's3') {
    if (!process.env.GRID_TF_STATE_BUCKET?.trim()) {
      out.push({
        key: 'GRID_TF_STATE_BUCKET',
        found: '(not set)',
        expect: 'S3 bucket name for Terraform state + archive/',
        fix: 'GRID_TF_STATE_BUCKET=mycompany-grid-tfstate',
      });
    }
    if (!process.env.GRID_TF_LOCK_TABLE?.trim()) {
      out.push({
        key: 'GRID_TF_LOCK_TABLE',
        found: '(not set)',
        expect: 'DynamoDB lock table',
        fix: 'GRID_TF_LOCK_TABLE=mycompany-grid-tflock',
      });
    }
  } else if (mode === 's3compat') {
    if (!process.env.GRID_TF_STATE_BUCKET?.trim()) {
      out.push({
        key: 'GRID_TF_STATE_BUCKET',
        found: '(not set)',
        expect: 'Bucket name on the S3-compatible store (OBS / MinIO / …)',
        fix: 'GRID_TF_STATE_BUCKET=mycompany-grid-tfstate',
      });
    }
    if (!archiveMirrorHasS3Endpoint({ mode: 's3compat' })) {
      out.push({
        key: 'GRID_TF_S3_ENDPOINT',
        found: '(not set)',
        expect:
          'S3-compatible API endpoint (required for ibm/ctrls/yotta/minio; huawei/ovh/otc can derive from GRID_TF_STATE_REGION)',
        fix: 'GRID_TF_S3_ENDPOINT=https://obs.cn-north-1.myhuaweicloud.com',
      });
    }
  } else if (mode === 'gcs') {
    if (!process.env.GRID_TF_STATE_BUCKET?.trim()) {
      out.push({
        key: 'GRID_TF_STATE_BUCKET',
        found: '(not set)',
        expect: 'GCS bucket name for Terraform state + archive/',
        fix: 'GRID_TF_STATE_BUCKET=mycompany-grid-tfstate',
      });
    }
  } else if (mode === 'azurerm') {
    if (!process.env.GRID_TF_AZURE_RESOURCE_GROUP?.trim()) {
      out.push({
        key: 'GRID_TF_AZURE_RESOURCE_GROUP',
        found: '(not set)',
        expect: 'Azure resource group for state storage',
      });
    }
    if (!process.env.GRID_TF_AZURE_STORAGE_ACCOUNT?.trim()) {
      out.push({
        key: 'GRID_TF_AZURE_STORAGE_ACCOUNT',
        found: '(not set)',
        expect: 'Azure storage account name',
      });
    }
    if (!process.env.GRID_TF_AZURE_CONTAINER?.trim()) {
      out.push({
        key: 'GRID_TF_AZURE_CONTAINER',
        found: '(not set)',
        expect: 'Blob container name (e.g. grid-tfstate)',
      });
    }
  } else if (mode === 'oci') {
    if (!process.env.GRID_TF_STATE_BUCKET?.trim()) {
      out.push({
        key: 'GRID_TF_STATE_BUCKET',
        found: '(not set)',
        expect: 'OCI Object Storage bucket for state + archive/',
        fix: 'GRID_TF_STATE_BUCKET=mycompany-grid-tfstate',
      });
    }
    if (!process.env.GRID_TF_OCI_NAMESPACE?.trim()) {
      out.push({
        key: 'GRID_TF_OCI_NAMESPACE',
        found: '(not set)',
        expect: 'OCI tenancy Object Storage namespace',
        fix: 'GRID_TF_OCI_NAMESPACE=<tenancy-namespace>',
      });
    }
    if (!archiveMirrorHasS3Endpoint({ mode: 'oci' })) {
      out.push({
        key: 'GRID_TF_S3_ENDPOINT',
        found: '(not set / cannot derive)',
        expect:
          'OCI S3-compatible endpoint for archive mirror (or set GRID_TF_OCI_NAMESPACE + GRID_TF_STATE_REGION to derive)',
        fix: 'GRID_TF_S3_ENDPOINT=https://<namespace>.compat.objectstorage.<region>.oraclecloud.com',
      });
    }
  } else if (mode === 'oss') {
    if (!process.env.GRID_TF_STATE_BUCKET?.trim()) {
      out.push({
        key: 'GRID_TF_STATE_BUCKET',
        found: '(not set)',
        expect: 'Alibaba OSS bucket for state + archive/',
        fix: 'GRID_TF_STATE_BUCKET=mycompany-grid-tfstate',
      });
    }
    if (!archiveMirrorHasS3Endpoint({ mode: 'oss' })) {
      out.push({
        key: 'GRID_TF_S3_ENDPOINT',
        found: '(not set / cannot derive)',
        expect:
          'OSS S3-compatible endpoint for archive mirror (or set GRID_TF_STATE_REGION to derive)',
        fix: 'GRID_TF_S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com',
      });
    }
  } else if (mode === 'cos') {
    if (!process.env.GRID_TF_STATE_BUCKET?.trim()) {
      out.push({
        key: 'GRID_TF_STATE_BUCKET',
        found: '(not set)',
        expect: 'Tencent COS bucket for state + archive/',
        fix: 'GRID_TF_STATE_BUCKET=mycompany-grid-tfstate-<appid>',
      });
    }
    if (!process.env.GRID_TF_STATE_REGION?.trim()) {
      out.push({
        key: 'GRID_TF_STATE_REGION',
        found: '(not set)',
        expect: 'COS region (e.g. ap-guangzhou)',
        fix: 'GRID_TF_STATE_REGION=ap-guangzhou',
      });
    }
    // Archive mirror uses S3-compatible COS API; default derived if unset.
  }

  return out;
}

function collectAuthFindings(): Finding[] {
  const out: Finding[] = [];
  if (truthy(process.env.GRID_AUTH_DISABLED)) {
    out.push({
      key: 'GRID_AUTH_DISABLED',
      found: display(process.env.GRID_AUTH_DISABLED),
      expect: 'unset / false in production',
    });
  }
  if (!process.env.GRID_AUTH_ADMIN_EMAIL?.trim()) {
    out.push({
      key: 'GRID_AUTH_ADMIN_EMAIL',
      found: '(not set)',
      expect: 'admin login email',
      fix: 'GRID_AUTH_ADMIN_EMAIL=admin@example.com',
    });
  }
  const pw = process.env.GRID_AUTH_ADMIN_PASSWORD || '';
  if (!pw.trim()) {
    out.push({
      key: 'GRID_AUTH_ADMIN_PASSWORD',
      found: '(not set)',
      expect: 'a real password (not empty)',
    });
  } else if (/^(change-me|changeme|password|admin)$/i.test(pw.trim())) {
    out.push({
      key: 'GRID_AUTH_ADMIN_PASSWORD',
      found: '(placeholder)',
      expect: 'a real password — replace the placeholder in .env',
    });
  }
  return out;
}

function collectModuleBankFindings(activeVersion?: string): Finding[] {
  const out: Finding[] = [];
  const bank = (process.env.GRID_MODULE_BANK || '').trim();
  if (!bank) {
    out.push({
      key: 'GRID_MODULE_BANK',
      found: '(not set)',
      expect: 'git URL to the module bank',
      fix: 'GRID_MODULE_BANK=https://github.com/gridplatform/grid-terraform.git',
    });
  } else if (!isGitRemoteBank(bank)) {
    out.push({
      key: 'GRID_MODULE_BANK',
      found: bank,
      expect: 'git URL (not a local path)',
      fix: 'GRID_MODULE_BANK=https://github.com/gridplatform/grid-terraform.git',
    });
  }

  const envRef = (
    process.env.GRID_MODULE_BANK_REF ||
    process.env.GRID_MODULE_BANK_BRANCH ||
    ''
  ).trim();
  const version = (activeVersion || envRef).trim();
  if (!isReleaseModuleBankRef(version)) {
    out.push({
      key: 'GRID_MODULE_BANK_REF',
      found: version || '(not set)',
      expect: 'release tag on grid-terraform (e.g. v0.1.0) — not main/master',
      fix: 'GRID_MODULE_BANK_REF=v0.1.0',
    });
  }
  return out;
}

function readGitopsSecretsFile(): {
  username?: string;
  token?: string;
  tokenExpiresAt?: string;
} {
  const dataDir =
    process.env.GRID_DATA_DIR?.trim() || path.join(process.cwd(), 'data');
  const secretsPath = path.join(dataDir, 'gitops-secrets.json');
  try {
    if (!fs.existsSync(secretsPath)) return {};
    const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as {
      username?: string;
      token?: string;
      tokenExpiresAt?: string;
    };
    return {
      username: raw.username?.trim() || undefined,
      token: raw.token?.trim() || undefined,
      tokenExpiresAt: raw.tokenExpiresAt?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

/** Read host Git HTTPS auth from env or GRID_DATA_DIR/gitops-secrets.json (Sources UI). */
export function readProductionGitopsAuth(): {
  username?: string;
  token?: string;
  expiresAt?: string;
  source?: 'env' | 'secrets-file';
} {
  const envUser = process.env.GRID_GITOPS_USERNAME?.trim();
  const envToken = process.env.GRID_GITOPS_TOKEN?.trim();
  const envExp = process.env.GRID_GITOPS_TOKEN_EXPIRES_AT?.trim();
  const file = readGitopsSecretsFile();

  const username = envUser || file.username || undefined;
  const token = envToken || file.token || undefined;
  const expiresAt = envExp || file.tokenExpiresAt || undefined;

  if (!token && !username && !expiresAt) return {};

  return {
    username,
    token,
    expiresAt,
    source: envToken || envUser || envExp ? 'env' : 'secrets-file',
  };
}

/**
 * Production GitOps gate: remote URL required; HTTPS remotes also require
 * username + host-issued token + expiry — no silent boot without credentials.
 * SSH remotes rely on deploy keys on the host (no Grid token).
 */
export function collectGitopsFindings(): Finding[] {
  const out: Finding[] = [];
  const repoUrl = process.env.GRID_GITOPS_REPO_URL?.trim() || '';

  if (!repoUrl) {
    out.push({
      key: 'GRID_GITOPS_REPO_URL',
      found: '(not set)',
      expect: 'git URL for intent repo (any Git host)',
      fix: 'GRID_GITOPS_REPO_URL=https://git.example.com/<org>/intent.git',
    });
    return out;
  }

  if (isSshGitUrl(repoUrl)) {
    return out;
  }

  // HTTPS — refuse production without username + token + expiry.
  const peeled = peelGitRemoteUserinfo(repoUrl);
  const auth = readProductionGitopsAuth();
  const username = auth.username || peeled.username;
  const hasToken = Boolean(auth.token || peeled.token);
  const expiresAt = auth.expiresAt;

  if (!username) {
    out.push({
      key: 'GRID_GITOPS_USERNAME',
      found: '(not set)',
      expect:
        'HTTPS Git username for the host token (often `git`; GitLab `oauth2`, Bitbucket `x-token-auth`) — Admin → Sources or GRID_GITOPS_USERNAME',
      fix: 'GRID_GITOPS_USERNAME=git',
    });
  }

  if (!hasToken) {
    out.push({
      key: 'GRID_GITOPS_TOKEN',
      found: '(not set)',
      expect:
        'host-issued PAT/deploy token for private HTTPS intent repos — Admin → Sources, or GRID_GITOPS_TOKEN (Grid does not mint tokens). Without a token, npm run prod will not start.',
      fix:
        'Set GRID_GITOPS_USERNAME=… GRID_GITOPS_TOKEN=… GRID_GITOPS_TOKEN_EXPIRES_AT=YYYY-MM-DD, or save all three in Admin → Sources (GRID_DATA_DIR/gitops-secrets.json). SSH URL + host deploy key is the alternative.',
    });
  }

  if (!expiresAt) {
    out.push({
      key: 'GRID_GITOPS_TOKEN_EXPIRES_AT',
      found: '(not set)',
      expect:
        'YYYY-MM-DD expiry of the host token (from your Git provider) — required in production with HTTPS auth',
      fix: 'GRID_GITOPS_TOKEN_EXPIRES_AT=2027-01-15   # or set “Token valid until” in Admin → Sources',
    });
  }

  return out;
}

/** Require Prometheus + Alertmanager URLs in production env. */
export function collectMonitoringFindings(): Finding[] {
  const out: Finding[] = [];
  if (!process.env.GRID_PROMETHEUS_URL?.trim()) {
    out.push({
      key: 'GRID_PROMETHEUS_URL',
      found: '(not set)',
      expect: 'http://127.0.0.1:9090 (local) or http://host.docker.internal:9090 (Compose)',
      fix: 'GRID_PROMETHEUS_URL=http://127.0.0.1:9090',
    });
  }
  if (!process.env.GRID_ALERTMANAGER_URL?.trim()) {
    out.push({
      key: 'GRID_ALERTMANAGER_URL',
      found: '(not set)',
      expect: 'http://127.0.0.1:9093 (local) or http://host.docker.internal:9093 (Compose)',
      fix: 'GRID_ALERTMANAGER_URL=http://127.0.0.1:9093',
    });
  }
  return out;
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => {
      let block =
        `  ${f.key}\n` + `    found:  ${f.found}\n` + `    expect: ${f.expect}`;
      if (f.fix) block += `\n    fix:    ${f.fix}`;
      return block;
    })
    .join('\n\n');
}

export type ProductionAssertOptions = {
  cwd?: string;
  /** Active module-bank version after settings load (preferred over env alone). */
  moduleBankVersion?: string;
  /** True when loadAppEnv found `.env`. */
  envFileLoaded?: boolean;
};

/** Fail production boot unless `.env` + required features are configured. */
export function assertProductionReady(opts: ProductionAssertOptions = {}): void {
  const cwd = opts.cwd || process.cwd();
  const envPath = path.join(cwd, '.env');
  const findings: Finding[] = [];

  const envOk =
    opts.envFileLoaded !== undefined
      ? opts.envFileLoaded
      : fs.existsSync(envPath);
  // Compose / systemd inject GRID_* without a package-local `.env` file.
  const injected =
    Boolean(process.env.GRID_MODULE_BANK?.trim()) &&
    Boolean(process.env.GRID_TF_BACKEND?.trim()) &&
    Boolean(process.env.GRID_GITOPS_REPO_URL?.trim()) &&
    Boolean(process.env.GRID_AUTH_ADMIN_EMAIL?.trim());
  if (!envOk && !injected) {
    findings.push({
      key: '.env',
      found: `missing at ${envPath}`,
      expect: 'production env file (copy from .env.example)',
      fix: `cp .env.example .env   # then edit ${envPath}`,
    });
  }

  findings.push(...collectAuthFindings());
  findings.push(...collectTfFindings());
  findings.push(...collectModuleBankFindings(opts.moduleBankVersion));
  findings.push(...collectGitopsFindings());
  findings.push(...collectMonitoringFindings());

  if (findings.length === 0) {
    const mode = resolveTfBackendMode();
    console.log(
      `[grid-core] production checks OK — state=${mode}` +
        (process.env.GRID_TF_STATE_BUCKET
          ? ` bucket=${process.env.GRID_TF_STATE_BUCKET}`
          : '') +
        ` module-bank-ref=${opts.moduleBankVersion || process.env.GRID_MODULE_BANK_REF}` +
        ` prometheus=${display(process.env.GRID_PROMETHEUS_URL)}` +
        ` alertmanager=${display(process.env.GRID_ALERTMANAGER_URL)}`
    );
    return;
  }

  const bankFound = display(process.env.GRID_MODULE_BANK);
  const refFound = display(
    opts.moduleBankVersion ||
      process.env.GRID_MODULE_BANK_REF ||
      process.env.GRID_MODULE_BANK_BRANCH,
    '(not set)'
  );
  const gitopsAuth = readProductionGitopsAuth();
  const gitopsAuthParts: string[] = [];
  if (gitopsAuth.username) gitopsAuthParts.push(`user=${gitopsAuth.username}`);
  else gitopsAuthParts.push('username missing');
  if (gitopsAuth.token) {
    gitopsAuthParts.push(`token present (${gitopsAuth.source || 'unknown'})`);
  } else {
    gitopsAuthParts.push(
      "no HTTPS token — Without any token, I'm not moving forward."
    );
  }
  if (gitopsAuth.expiresAt) gitopsAuthParts.push(`expires ${gitopsAuth.expiresAt}`);
  else gitopsAuthParts.push('expiry missing');
  const gitopsAuthLine = gitopsAuthParts.join(', ');

  throw new Error(
    `[grid-core] production boot refused — ${findings.length} setting(s) need fixing in .env\n` +
      `\n` +
      `What I loaded:\n` +
      `  module bank:  ${bankFound}\n` +
      `  module ref:   ${refFound}   ← must be a released tag (example: v0.1.0)\n` +
      `  tf backend:   ${display(process.env.GRID_TF_BACKEND, '(unset → local)')}\n` +
      `  gitops repo:  ${display(process.env.GRID_GITOPS_REPO_URL)}\n` +
      `  gitops auth:  ${gitopsAuthLine}\n` +
      `  prometheus:   ${display(process.env.GRID_PROMETHEUS_URL)}\n` +
      `  alertmanager: ${display(process.env.GRID_ALERTMANAGER_URL)}\n` +
      `\n` +
      `Issues:\n` +
      formatFindings(findings) +
      `\n\n` +
      `Example production snippet (.env):\n` +
      `  GRID_MODULE_BANK=https://github.com/gridplatform/grid-terraform.git\n` +
      `  GRID_MODULE_BANK_REF=v0.1.0\n` +
      `  GRID_GITOPS_REPO_URL=https://git.example.com/<org>/intent.git\n` +
      `  GRID_GITOPS_USERNAME=git\n` +
      `  GRID_GITOPS_TOKEN=<host-PAT-or-deploy-token>\n` +
      `  GRID_GITOPS_TOKEN_EXPIRES_AT=2027-01-15\n` +
      `  GRID_TF_BACKEND=s3\n` +
      `  GRID_TF_STATE_BUCKET=mycompany-grid-tfstate\n` +
      `  GRID_TF_LOCK_TABLE=mycompany-grid-tflock\n` +
      `  GRID_TF_STATE_REGION=us-east-1\n` +
      `  GRID_AUTH_ADMIN_EMAIL=admin@example.com\n` +
      `  GRID_AUTH_ADMIN_PASSWORD=<real-password>\n` +
      `  GRID_PROMETHEUS_URL=http://127.0.0.1:9090\n` +
      `  GRID_ALERTMANAGER_URL=http://127.0.0.1:9093\n` +
      `  GRID_MONITORING_CONFIG_DIR=./install/monitoring\n` +
      `\n` +
      `Dev: npm run dev + .env.development. Monitoring: install/monitoring/README.md\n` +
      `Docs: doc docs/Install/Remote_State.md · docs/Install/Dev_Vs_Prod.md · docs/Getting-Started/Your_Intent_Repository.md`
  );
}

/** Incomplete remote backend — illegal in any mode once GRID_TF_BACKEND is set. */
export function assertTfBackendConfigOrThrow(): void {
  const mode = resolveTfBackendMode();
  if (mode === 'local') return;
  const findings = collectTfFindings();
  if (findings.length === 0) return;
  throw new Error(
    `[grid-core] incomplete remote Terraform state config:\n\n` +
      formatFindings(findings) +
      `\n\nSee grid-docs docs/install/remote-state.md`
  );
}
