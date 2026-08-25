import { rmSync } from 'node:fs';

/**
 * tsc writes into types/ but never removes what is no longer generated, so a
 * renamed source file leaves a stale .d.ts behind — which then ships, and
 * points consumers at a module that does not exist. Cheaper to always start
 * from an empty directory.
 */
rmSync(new URL('../types', import.meta.url), { recursive: true, force: true });
