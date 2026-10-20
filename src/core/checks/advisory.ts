import type { Runtime } from '../io/reads.js';
import type { Check, CheckId, ResourceId } from '../types.js';

/** A read-only check with no `setup` step. */
export interface Advisory {
  id: Exclude<CheckId, ResourceId>;
  run(rt: Runtime): Promise<Omit<Check, 'id'>>;
}

export const pass = (message: string) => ({ status: 'pass', message }) as const;
export const warn = (message: string, fix?: string) => ({ status: 'warn', message, ...(fix ? { fix } : {}) }) as const;
export const skipped = (message: string) => ({ status: 'skipped', message }) as const;
