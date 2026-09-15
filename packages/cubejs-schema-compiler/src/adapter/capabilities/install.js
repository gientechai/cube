/**
 * Install query capability mixins onto a Query class prototype.
 *
 * Capabilities are plain method tables; dialects keep overriding hooks via the
 * normal prototype chain (`override` / `super.method()`).
 *
 * Do not add hand-written thin delegates on BaseQuery — add methods to a
 * capability module and list it in QUERY_CAPABILITIES.
 */
import { SemiAdditiveCapability } from './semiAdditive';
import { PeriodAverageCapability } from './periodAverage';
import { PeriodAverageSemiAdditiveCapability } from './periodAverageSemiAdditive';
import { MeasureFilterCapability } from './measureFilter';
import { MeasureSqlUtils } from './measureSqlUtils';

/** @type {{ name: string, methods: Record<string, unknown> }[]} */
export const QUERY_CAPABILITIES = [
  { name: 'SemiAdditiveCapability', methods: SemiAdditiveCapability },
  { name: 'PeriodAverageCapability', methods: PeriodAverageCapability },
  { name: 'PeriodAverageSemiAdditiveCapability', methods: PeriodAverageSemiAdditiveCapability },
  { name: 'MeasureFilterCapability', methods: MeasureFilterCapability },
  { name: 'MeasureSqlUtils', methods: MeasureSqlUtils },
];

/**
 * @param {Function} QueryClass typically BaseQuery
 * @param {{
 *   allowOverwrite?: string[],
 *   capabilities?: { name: string, methods: Record<string, unknown> }[],
 * }} [options]
 */
export function installQueryCapabilities(QueryClass, options = {}) {
  const proto = QueryClass.prototype;
  const allow = new Set(options.allowOverwrite || []);
  const capabilities = options.capabilities || QUERY_CAPABILITIES;
  /** @type {Map<string, string>} */
  const seen = new Map();

  for (const { name: capabilityName, methods } of capabilities) {
    for (const [name, value] of Object.entries(methods)) {
      if (typeof value !== 'function') {
        continue;
      }

      if (seen.has(name)) {
        throw new Error(
          `Duplicate capability method '${name}' ` +
          `(${seen.get(name)} vs ${capabilityName}) while installing ${QueryClass.name}`
        );
      }
      seen.set(name, capabilityName);

      const existing = Object.getOwnPropertyDescriptor(proto, name);
      if (existing && !allow.has(name)) {
        throw new Error(
          `Capability method '${name}' conflicts with ${QueryClass.name}.prototype ` +
          `(from ${capabilityName})`
        );
      }

      Object.defineProperty(proto, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
}
