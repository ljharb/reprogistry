'use strict';

/**
 * Local reproduce module - inlined and modified from the `reproduce` package.
 * This allows for customization to support version-aware reproduction.
 *
 * Original: https://github.com/vltpkg/reproduce
 */

var execSync = require('child_process').execSync;
var fs = require('fs');
var os = require('os');
var path = require('path');

var pacote = require('pacote');
var semver = require('semver');

var pkg = require('../package.json');

// npm >= 5.0.0 supports --before flag for time-based dependency resolution
var NPM_BEFORE_VERSION = '5.0.0';

/**
 * Rewrite workspace: protocol dependencies to use * instead.
 * This allows npm to install monorepo packages that use yarn/pnpm workspaces.
 *
 * @param {string} packageDir - Directory containing package.json
 */
function rewriteWorkspaceDeps(packageDir) {
	var pkgPath = path.join(packageDir, 'package.json');
	var pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	var modified = false;
	var depTypes = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

	for (var i = 0; i < depTypes.length; i++) {
		var deps = pkgJson[depTypes[i]];
		if (deps) {
			for (var name in deps) {
				if (Object.prototype.hasOwnProperty.call(deps, name)) {
					var version = deps[name];
					if (typeof version === 'string' && version.indexOf('workspace:') === 0) {
						deps[name] = '*';
						modified = true;
					}
				}
			}
		}
	}

	if (modified) {
		fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2));
	}
}

// Minimum Node.js version that can be installed via nvm in GitHub Actions
var MIN_NODE_VERSION = '0.8.0';

// NVM_DIR for nvm integration
var NVM_DIR = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
var NVM_SCRIPT = path.join(NVM_DIR, 'nvm.sh');

var DEFAULT_CACHE_DIR = (function () {
	switch (os.platform()) {
		case 'darwin':
			return path.join(os.homedir(), 'Library', 'Caches', 'reproduce');
		case 'win32':
			return path.join(os.homedir(), 'AppData', 'Local', 'reproduce', 'Cache');
		default:
			return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'reproduce');
	}
}());
var DEFAULT_CACHE_FILE = 'cache.json';
var EXEC_OPTIONS = {
	stdio: [
		'pipe',
		'pipe',
		'pipe',
	],
};

// Helper to merge objects without Object.assign (for older Node compatibility)
function merge() {
	var result = {};
	for (var i = 0; i < arguments.length; i++) {
		var obj = arguments[i];
		if (obj) {
			for (var key in obj) {
				if (Object.prototype.hasOwnProperty.call(obj, key)) {
					result[key] = obj[key];
				}
			}
		}
	}
	return result;
}

function exec(command, options) {
	return execSync(command, merge(EXEC_OPTIONS, options)).toString().trim();
}

function isNvmAvailable() {
	return fs.existsSync(NVM_SCRIPT);
}

function execWithNodeVersion(nodeVersion, command, options) {
	var version = nodeVersion.replace(/^v/, '');
	var nvmCmd = 'source "' + NVM_SCRIPT + '" && nvm use ' + version + ' --silent && ' + command;

	return execSync(nvmCmd, merge(EXEC_OPTIONS, options, { shell: '/bin/bash' })).toString().trim();
}

function tryInstallNodeVersion(version) {
	try {
		// Try to install directly - nvm will use cached version if already installed
		console.log('  -> Installing node ' + version + ' via nvm...');
		execSync(
			'source "' + NVM_SCRIPT + '" && nvm install ' + version + ' 2>/dev/null',
			merge(EXEC_OPTIONS, { shell: '/bin/bash' }),
		);

		// Verify it's actually usable
		var installedVersion = execSync(
			'source "' + NVM_SCRIPT + '" && nvm use ' + version + ' --silent && node --version 2>/dev/null',
			merge(EXEC_OPTIONS, { shell: '/bin/bash' }),
		).toString().trim().replace(/^v/, '');

		return installedVersion;
	} catch (err) {
		console.error('  -> Failed to install node ' + version + ': ' + err.message);
		return null;
	}
}

function ensureNodeVersion(nodeVersion) {
	if (!isNvmAvailable()) {
		return null;
	}

	var version = nodeVersion.replace(/^v/, '');
	var coerced = semver.coerce(version);
	var major = coerced ? coerced.major : null;

	// Try exact version first
	var installed = tryInstallNodeVersion(version);
	if (installed) {
		return installed;
	}

	// If exact version failed, try major.x (latest in that major line)
	if (major !== null) {
		console.log('  -> Exact version ' + version + ' unavailable, trying node ' + major + ' (latest)...');
		installed = tryInstallNodeVersion(String(major));
		if (installed) {
			return installed;
		}

		// If that failed too, try next major version
		var nextMajor = major + 1;
		console.log('  -> Node ' + major + ' unavailable, trying node ' + nextMajor + '...');
		installed = tryInstallNodeVersion(String(nextMajor));
		if (installed) {
			return installed;
		}
	}

	console.error('  -> Could not install any compatible node version for ' + version);
	return null;
}

function getNpmVersion(nodeVersion) {
	if (nodeVersion && isNvmAvailable()) {
		try {
			return execWithNodeVersion(nodeVersion, 'npm --version');
		} catch (e) { // eslint-disable-line no-unused-vars
			// Fall back to current npm
		}
	}
	return exec('npm --version');
}

function npmInstall(dir, options) {
	options = options || {};
	var cmd = 'npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --force';

	if (!options.before) {
		throw new Error('npmInstall requires a --before timestamp for reproducible builds');
	}

	if (!options.npmVersion) {
		throw new Error('npmInstall requires npmVersion to verify --before support');
	}

	if (!semver.gte(options.npmVersion, NPM_BEFORE_VERSION)) {
		throw new Error('npm version ' + options.npmVersion + ' does not support --before (requires >= ' + NPM_BEFORE_VERSION + ')');
	}

	cmd += ' --before="' + options.before + '"';
	console.log('  -> Using --before="' + options.before + '" with npm ' + options.npmVersion);

	// Set NPM_CONFIG_BEFORE env var for transitive npm calls (e.g., prepack scripts)
	var envWithBefore = {};
	for (var key in process.env) {
		if (Object.prototype.hasOwnProperty.call(process.env, key)) {
			envWithBefore[key] = process.env[key];
		}
	}
	envWithBefore.NPM_CONFIG_BEFORE = options.before;

	var fullCmd = 'cd "' + dir + '" && ' + cmd;

	if (options.nodeVersion && isNvmAvailable()) {
		try {
			execWithNodeVersion(options.nodeVersion, fullCmd, { env: envWithBefore });
			return;
		} catch (e) {
			console.error('  -> Failed with node ' + options.nodeVersion + ', falling back to current: ' + e.message);
		}
	}

	exec(fullCmd, { env: envWithBefore });
}

function npmPack(dir, options) {
	options = options || {};
	var cmd = 'cd "' + dir + '" && npm pack --dry-run --json';

	// Set NPM_CONFIG_BEFORE env var for prepack scripts
	var packEnv = null;
	if (options.before) {
		packEnv = {};
		for (var key in process.env) {
			if (Object.prototype.hasOwnProperty.call(process.env, key)) {
				packEnv[key] = process.env[key];
			}
		}
		packEnv.NPM_CONFIG_BEFORE = options.before;
		console.log('  -> npm pack using NPM_CONFIG_BEFORE="' + options.before + '"');
	}

	var execOpts = packEnv ? { env: packEnv } : {};
	var output;
	if (options.nodeVersion && isNvmAvailable()) {
		try {
			output = execWithNodeVersion(options.nodeVersion, cmd, execOpts);
		} catch (e) {
			console.error('  -> npm pack failed with node ' + options.nodeVersion + ', falling back to current: ' + e.message);
			output = exec(cmd, execOpts);
		}
	} else {
		output = exec(cmd, execOpts);
	}

	return JSON.parse(output)[0];
}

module.exports = async function reproduce(spec, opts) {
	opts = merge({
		cache: {},
		cacheDir: DEFAULT_CACHE_DIR,
		cacheFile: DEFAULT_CACHE_FILE,
		strategy: 'npm',
	}, opts);

	var cacheFilePath = path.join(opts.cacheDir, opts.cacheFile);

	if (!fs.existsSync(cacheFilePath)) {
		fs.mkdirSync(opts.cacheDir, { recursive: true });
		fs.writeFileSync(cacheFilePath, JSON.stringify(opts.cache));
	}

	if (Object.keys(opts.cache).length === 0) {
		opts.cache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
	}

	if (!opts.force && opts.cache && Object.prototype.hasOwnProperty.call(opts.cache, spec)) {
		return opts.cache[spec];
	}

	try {
		var manifest = await pacote.manifest(spec, { fullMetadata: true });

		if (!manifest || !manifest.repository || !manifest.repository.url) {
			return false;
		}

		var repo = manifest.repository;
		var url = repo.url;

		var parsed;
		try {
			var normalizedUrl = url
				.replace(/^git\+/, '')
				.replace(/^git:\/\//, 'https://')
				.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
				.replace(/^git@github\.com:/, 'https://github.com/');
			parsed = new URL(normalizedUrl);
		} catch (e) { // eslint-disable-line no-unused-vars
			return false;
		}

		if (parsed.host !== 'github.com') {
			return false;
		}

		var location = parsed.pathname.replace('.git', '').replace(/^\//, '');
		var repoPath = repo.directory ? '::path:' + repo.directory : '';

		// Determine git ref: prefer gitHead, then try version tags, finally fallback to HEAD
		var ref = manifest.gitHead;
		if (!ref) {
			// Try to find a matching tag (v1.2.3 or 1.2.3)
			var tagRef = 'v' + manifest.version;
			try {
				var tagCheck = exec('git ls-remote --tags "https://github.com/' + location + '.git" "' + tagRef + '" "' + manifest.version + '" 2>/dev/null || true');
				if (tagCheck) {
					var lines = tagCheck.split('\n').filter(Boolean);
					if (lines.length > 0) {
						// Prefer exact version tag over v-prefixed
						var exactMatch = lines.find(function (l) { return l.endsWith('refs/tags/' + manifest.version); });
						var vMatch = lines.find(function (l) { return l.endsWith('refs/tags/v' + manifest.version); });
						if (exactMatch) {
							ref = manifest.version;
							console.log('  -> Using git tag: ' + ref);
						} else if (vMatch) {
							ref = 'v' + manifest.version;
							console.log('  -> Using git tag: ' + ref);
						}
					}
				}
			} catch (e) {
				// Ignore tag lookup failures
			}
		}
		if (!ref) {
			ref = 'HEAD';
			console.log('  -> Warning: No gitHead or version tag found, using HEAD');
		}

		var source = 'github:' + location + '#' + ref + repoPath;

		var packed = {};
		var repoCacheDir = path.join(opts.cacheDir, manifest.name.replace('/', '__'));

		var originalNodeVersion = manifest._nodeVersion || null;
		var installedNodeVersion = null;

		// Clamp node version to minimum installable version
		if (originalNodeVersion && semver.lt(semver.coerce(originalNodeVersion), MIN_NODE_VERSION)) {
			console.log('  -> Node ' + originalNodeVersion + ' is below minimum, clamping to ' + MIN_NODE_VERSION);
			originalNodeVersion = MIN_NODE_VERSION;
		}

		if (originalNodeVersion && isNvmAvailable()) {
			installedNodeVersion = ensureNodeVersion(originalNodeVersion);
			if (installedNodeVersion) {
				console.log('  -> Using node version: ' + installedNodeVersion + (installedNodeVersion !== originalNodeVersion ? ' (requested ' + originalNodeVersion + ')' : ''));
			}
		}

		var npmVersion = getNpmVersion(installedNodeVersion);

		var publishTime = null;
		try {
			var packument = await pacote.packument(manifest.name, { fullMetadata: true });
			if (packument.time && packument.time[manifest.version]) {
				publishTime = packument.time[manifest.version];
			}
		} catch (e) {
			console.error('  -> Failed to fetch packument for publish time: ' + e.message);
		}

		if (!publishTime) {
			throw new Error('Could not determine publish time for ' + spec + ' - required for --before');
		}

		try {
			if (!fs.existsSync(repoCacheDir)) {
				exec('git clone --depth 1 "https://github.com/' + location + '.git" "' + repoCacheDir + '" 2>/dev/null');
			}

			exec('cd "' + repoCacheDir + '" && git fetch --depth 1 origin "' + ref + '" 2>/dev/null || git fetch origin 2>/dev/null || true');
			exec('cd "' + repoCacheDir + '" && git checkout "' + ref + '" 2>/dev/null || git checkout FETCH_HEAD 2>/dev/null');

			var packageDir = repo.directory ? path.join(repoCacheDir, repo.directory) : repoCacheDir;

			rewriteWorkspaceDeps(packageDir);
			npmInstall(packageDir, {
				before: publishTime,
				nodeVersion: installedNodeVersion,
				npmVersion: npmVersion,
			});

			packed = npmPack(packageDir, {
				nodeVersion: installedNodeVersion,
				before: publishTime,
			});
		} catch (e) {
			console.error('  -> Reproduce error: ' + e.message);
		}

		var result = {
			reproduceVersion: pkg.version + '-local',
			timestamp: new Date().toISOString(),
			os: process.platform,
			arch: process.arch,
			strategy: 'npm:' + npmVersion,
			reproduced: packed && packed.integrity ? manifest.dist.integrity === packed.integrity : false,
			attested: !!(manifest.dist && manifest.dist.attestations && manifest.dist.attestations.url),
			package: {
				spec: spec,
				name: manifest.name,
				version: manifest.version,
				location: manifest.dist.tarball,
				integrity: manifest.dist.integrity,
				publishedAt: publishTime || null,
				publishedWith: {
					node: manifest._nodeVersion || null,
					npm: manifest._npmVersion || null,
				},
			},
			source: {
				integrity: packed && packed.integrity ? packed.integrity : null,
				location: repo.url,
				spec: source,
			},
		};

		opts.cache[spec] = result;
		fs.writeFileSync(cacheFilePath, JSON.stringify(opts.cache, null, 2));

		return result;
	} catch (e) {
		console.error('  -> Failed: ' + e.message);
		opts.cache[spec] = false;
		return false;
	}
};
