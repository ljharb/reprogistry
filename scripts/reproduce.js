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

function exec(command, options) {
	return execSync(command, Object.assign({}, EXEC_OPTIONS, options)).toString().trim();
}

function isNvmAvailable() {
	return fs.existsSync(NVM_SCRIPT);
}

function execWithNodeVersion(nodeVersion, command, options) {
	var version = nodeVersion.replace(/^v/, '');
	var nvmCmd = 'source "' + NVM_SCRIPT + '" && nvm use ' + version + ' --silent && ' + command;

	return execSync(nvmCmd, Object.assign({}, EXEC_OPTIONS, options, { shell: '/bin/bash' })).toString().trim();
}

function ensureNodeVersion(nodeVersion) {
	if (!isNvmAvailable()) {
		return false;
	}

	var version = nodeVersion.replace(/^v/, '');

	try {
		var installed = execSync(
			'source "' + NVM_SCRIPT + '" && nvm ls ' + version + ' 2>/dev/null',
			Object.assign({}, EXEC_OPTIONS, { shell: '/bin/bash' }),
		).toString();

		if (installed.indexOf(version) !== -1 && installed.indexOf('N/A') === -1) {
			return true;
		}

		console.log('  -> Installing node ' + version + ' via nvm...');
		execSync(
			'source "' + NVM_SCRIPT + '" && nvm install ' + version,
			Object.assign({}, EXEC_OPTIONS, { shell: '/bin/bash' }),
		);
		return true;
	} catch (err) {
		console.error('  -> Failed to ensure node ' + version + ': ' + err.message);
		return false;
	}
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
	var cmd = 'npm install --ignore-scripts --no-audit --no-fund';

	if (options.before && options.npmVersion) {
		if (semver.gte(options.npmVersion, NPM_BEFORE_VERSION)) {
			cmd += ' --before="' + options.before + '"';
		}
	}

	var fullCmd = 'cd "' + dir + '" && ' + cmd;

	if (options.nodeVersion && isNvmAvailable()) {
		try {
			execWithNodeVersion(options.nodeVersion, fullCmd);
			return;
		} catch (e) {
			console.error('  -> Failed with node ' + options.nodeVersion + ', falling back to current: ' + e.message);
		}
	}

	exec(fullCmd);
}

function npmPack(dir, options) {
	options = options || {};
	var cmd = 'cd "' + dir + '" && npm pack --dry-run --json';

	var output;
	if (options.nodeVersion && isNvmAvailable()) {
		try {
			output = execWithNodeVersion(options.nodeVersion, cmd);
		} catch (e) {
			console.error('  -> npm pack failed with node ' + options.nodeVersion + ', falling back to current: ' + e.message);
			output = exec(cmd);
		}
	} else {
		output = exec(cmd);
	}

	return JSON.parse(output)[0];
}

module.exports = async function reproduce(spec, opts) {
	opts = Object.assign({
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
			parsed = new URL(url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://'));
		} catch (e) { // eslint-disable-line no-unused-vars
			return false;
		}

		if (parsed.host !== 'github.com') {
			return false;
		}

		var location = parsed.pathname.replace('.git', '').replace(/^\//, '');
		var repoPath = repo.directory ? '::path:' + repo.directory : '';
		var ref = manifest.gitHead || 'HEAD';
		var source = 'github:' + location + '#' + ref + repoPath;

		var packed = {};
		var repoCacheDir = path.join(opts.cacheDir, manifest.name.replace('/', '__'));

		var originalNodeVersion = manifest._nodeVersion || null;
		var useOriginalNode = false;

		if (originalNodeVersion && isNvmAvailable()) {
			useOriginalNode = ensureNodeVersion(originalNodeVersion);
			if (useOriginalNode) {
				console.log('  -> Using original node version: ' + originalNodeVersion);
			}
		}

		var npmVersion = getNpmVersion(useOriginalNode ? originalNodeVersion : null);

		var publishTime = null;
		try {
			var packument = await pacote.packument(manifest.name, { fullMetadata: true });
			if (packument.time && packument.time[manifest.version]) {
				publishTime = packument.time[manifest.version];
			}
		} catch (e) { // eslint-disable-line no-unused-vars
			// Ignore - we'll proceed without --before
		}

		try {
			if (!fs.existsSync(repoCacheDir)) {
				exec('git clone --depth 1 "https://github.com/' + location + '.git" "' + repoCacheDir + '" 2>/dev/null');
			}

			exec('cd "' + repoCacheDir + '" && git fetch --depth 1 origin "' + ref + '" 2>/dev/null || git fetch origin 2>/dev/null || true');
			exec('cd "' + repoCacheDir + '" && git checkout "' + ref + '" 2>/dev/null || git checkout FETCH_HEAD 2>/dev/null');

			var packageDir = repo.directory ? path.join(repoCacheDir, repo.directory) : repoCacheDir;

			npmInstall(packageDir, {
				before: publishTime,
				nodeVersion: useOriginalNode ? originalNodeVersion : null,
				npmVersion: npmVersion,
			});

			packed = npmPack(packageDir, {
				nodeVersion: useOriginalNode ? originalNodeVersion : null,
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
