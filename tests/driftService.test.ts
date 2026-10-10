import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveDriftTerraformDirs } from '../src/services/driftService';
import type { Infrastructure } from '../src/types/api';
import { config } from '../src/config';

function stubInfra(partial: Partial<Infrastructure>): Infrastructure {
  return {
    id: 'infra-1',
    userId: 'u1',
    name: 'demo-vpc',
    environment: 'development',
    provider: 'AWS',
    configJson: {
      provider: 'aws',
      project: 'demo-app',
      resources: [{ type: 'vpc', name: 'demo-vpc' }],
      metadata: { name: 'demo-vpc', environment: 'development' },
    },
    status: 'running',
    autoApprove: true,
    driftDetection: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('resolveDriftTerraformDirs', () => {
  it('uses archive/ under gitPath (same as lifecycle)', () => {
    const infra = stubInfra({
      gitPath: 'projects/demo-app/aws/development/vpc/demo-vpc.json',
      project: 'demo-app',
    });
    const dirs = resolveDriftTerraformDirs(infra);
    expect(dirs.writeArchive).toBe(true);
    expect(dirs.terraformDir).toBe(
      path.join(
        config.configRoot,
        'archive',
        'projects/demo-app/aws/development/vpc/demo-vpc'
      )
    );
    expect(dirs.configPath).toBe(
      path.join(config.configRoot, 'projects/demo-app/aws/development/vpc/demo-vpc.json')
    );
  });

  it('derives archive path when gitPath is missing (API-created units)', () => {
    const infra = stubInfra({ gitPath: undefined, project: 'demo-app' });
    const dirs = resolveDriftTerraformDirs(infra);
    expect(dirs.writeArchive).toBe(true);
    expect(dirs.derivedGitPath).toBe(
      'projects/demo-app/aws/development/vpc/demo-vpc.json'
    );
    expect(dirs.terraformDir).toContain(
      path.join('archive', 'projects', 'demo-app', 'aws', 'development', 'vpc', 'demo-vpc')
    );
    // Must NOT fall back to workDir/<id>/generated — that was the drift UI blank-output bug.
    expect(dirs.terraformDir).not.toContain(path.join('workspaces', 'infra-1'));
  });
});
