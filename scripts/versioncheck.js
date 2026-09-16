/**
 * Sanity check for version consistency across manifests and the latest tag.
 *
 * Usage: npm run versioncheck
 */

import { execSync } from 'child_process';

// Read package manifests
import packageJson from '../package.json' with { type: "json" };
import vscodePackageJson from '../vscode/package.json' with { type: "json" };

let latestTag;
try {
    latestTag = execSync('git describe --tags --abbrev=0', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().replace(/^v/, '');
} catch {
    latestTag = '0.0.0';
    console.warn('No tags found in repository; assuming baseline version 0.0.0');
}

// Parses "major.minor.patch[-prerelease]" into a comparable tuple.
function parseSemver(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
    if (!match) {
        throw new Error(`Invalid semver version: ${version}`);
    }
    const [, major, minor, patch, prerelease] = match;
    return { major: +major, minor: +minor, patch: +patch, prerelease };
}

// Returns -1, 0, or 1 depending on whether `a` is less than, equal to, or greater than `b`.
function compareSemver(a, b) {
    const va = parseSemver(a);
    const vb = parseSemver(b);

    for (const key of ['major', 'minor', 'patch']) {
        if (va[key] !== vb[key]) {
            return va[key] < vb[key] ? -1 : 1;
        }
    }

    // A version with a prerelease tag is lower precedence than the same version without one.
    if (va.prerelease === vb.prerelease) return 0;
    if (va.prerelease === undefined) return 1;
    if (vb.prerelease === undefined) return -1;
    return va.prerelease < vb.prerelease ? -1 : 1;
}

let errorno = 0;

if (packageJson.version !== vscodePackageJson.version) {
    console.error(`Version mismatch: package.json version (${packageJson.version}) does not match vscode/package.json version (${vscodePackageJson.version})`);
    errorno = 1;
}

if (errorno === 0) {
    const comparison = compareSemver(packageJson.version, latestTag);

    if (comparison === 0) {
        console.log(`Versions are consistent and match the latest tag (v${latestTag}); nothing to release.`);
    } else if (comparison > 0) {
        console.log(`Versions are consistent and ready for a new tag: v${packageJson.version} (latest tag is v${latestTag})`);
        console.log(`Run: git tag v${packageJson.version} && git push origin v${packageJson.version}`);
    } else {
        console.error(`Version mismatch: manifest version (${packageJson.version}) is behind the latest tag (v${latestTag})`);
        errorno = 1;
    }
}

process.exit(errorno);