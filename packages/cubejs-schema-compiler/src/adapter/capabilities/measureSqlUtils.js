/**
 * Shared helpers for projecting raw measure SQL (evaluate + cube prefix + schema filters).
 * Keep this module tiny — not a dumping ground for unrelated query logic.
 */

/**
 * @param {*} query BaseQuery (or dialect subclass) instance
 * @param {*} measure BaseMeasure instance
 * @returns {{ sql: string|undefined|null|false, rendered: string }}
 */
export function buildRawMeasureSql(query, measure) {
  const cubeName = measure.cube().name;
  const symbol = measure.measureDefinition();
  const sql = symbol.sql && query.evaluateSql(cubeName, symbol.sql);
  const rendered = query.applyMeasureFilters(
    query.autoPrefixWithCubeName(cubeName, sql, false),
    symbol,
    cubeName,
  );
  return { sql, rendered };
}

/**
 * Capability-style helpers installed onto BaseQuery.prototype.
 */
export const MeasureSqlUtils = {
  /**
   * Always returns filtered/prefixed SQL (semi-additive base_data columns).
   * @param {*} measure
   * @returns {string}
   */
  rawMeasureSql(measure) {
    return buildRawMeasureSql(this, measure).rendered;
  },
};
