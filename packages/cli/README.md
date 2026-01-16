# reprogistry <sup>[![Version Badge][npm-version-svg]][package-url]</sup>

[![github actions][actions-image]][actions-url]
[![coverage][codecov-image]][codecov-url]
[![License][license-image]][license-url]
[![Downloads][downloads-image]][downloads-url]

[![npm badge][npm-badge-png]][package-url]

CLI for checking npm package reproducibility scores from the [reprogistry](https://github.com/reprogistry/reprogistry) project.

## Installation

```sh
npm install -g reprogistry
```

Or use with npx:

```sh
npx reprogistry lodash@latest
```

## Usage

```sh
reprogistry [options] <package-spec>
```

### Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--json` | `-j` | Output as JSON |
| `--purl` | `-p` | Treat input as a Package URL (PURL) |
| `--help` | `-h` | Show help message |
| `--version` | `-v` | Show version number |

## Examples

### Basic Usage

Check a specific version:

```sh
reprogistry lodash@4.17.21
```

Check the latest version:

```sh
reprogistry lodash@latest
```

Check a version range (resolves to latest matching):

```sh
reprogistry lodash@^4.17.0
```

### Using PURL

Check using a Package URL:

```sh
reprogistry -p pkg:npm/lodash@4.17.21
```

Scoped packages use URL encoding:

```sh
reprogistry -p pkg:npm/%40types/node@22.0.0
```

### JSON Output

Get machine-readable output:

```sh
reprogistry -j express@4.18.2
```

Example output:

```json
{
  "name": "express",
  "version": "4.18.2",
  "score": 0.9995,
  "tier": "Excellent",
  "status": "not-reproducible",
  "reproduced": false,
  "dependencies": {
    "total": 30,
    "tracked": 15,
    "missing": 15,
    "averageScore": 0.98,
    "averageTier": "Excellent"
  }
}
```

## Output

The CLI displays:

- **Package**: The package name
- **Version**: The resolved version
- **Reproducible**: Whether the build is fully reproducible
- **Score**: Percentage of files that match between source and published package
- **Tier**: Reproducibility tier based on score
- **Direct Dependencies**: Aggregate stats for tracked dependencies

### Tiers

| Tier | Score |
|------|-------|
| Perfect | 100% |
| Excellent | 99%+ |
| Good | 90%+ |
| High Risk | < 90% |

## Exit Codes

| Code | Description |
|------|-------------|
| `0` | Success |
| `1` | Invalid input or execution failed |

## Related

- [reprogistry](https://github.com/reprogistry/reprogistry) - Registry of npm package reproducibility data
- [reproduce](https://www.npmjs.com/package/reproduce) - Tool for reproducing npm package builds

## Tests

Clone the repo, `npm install`, and run `npm test`.

## License

MIT

[package-url]: https://npmjs.org/package/reprogistry
[npm-version-svg]: https://versionbadge.vercel.app/npm/reprogistry.svg
[npm-badge-png]: https://nodei.co/npm/reprogistry.png?downloads=true&stars=true
[license-image]: https://img.shields.io/npm/l/reprogistry.svg
[license-url]: LICENSE
[downloads-image]: https://img.shields.io/npm/dm/reprogistry.svg
[downloads-url]: https://npm-stat.com/charts.html?package=reprogistry
[codecov-image]: https://codecov.io/gh/reprogistry/reprogistry/branch/main/graphs/badge.svg
[codecov-url]: https://app.codecov.io/gh/reprogistry/reprogistry/
[actions-image]: https://img.shields.io/endpoint?url=https://github-actions-badge-u3jn4tfber.now.sh/api/github/reprogistry/reprogistry
[actions-url]: https://github.com/reprogistry/reprogistry/actions
