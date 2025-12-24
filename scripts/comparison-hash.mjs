/**
 * Get the git blob hash of the comparison logic to detect when it changes.
 * This allows automatic re-processing when compare.mjs is updated.
 *
 * @module comparison-hash
 */

import { execSync } from 'node:child_process';

/** @type {string} */
export default execSync('git rev-parse @:scripts/compare.mjs', { encoding: 'utf8' }).trim();
