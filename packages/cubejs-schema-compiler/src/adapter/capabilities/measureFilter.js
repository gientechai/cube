/**
 * Outer measure-filter wrapping (HAVING → subquery WHERE).
 * Used by period_average paths and dialects that cannot put window functions in HAVING.
 */
import R from 'ramda';

export const MeasureFilterCapability = {
  findMeasureForFilter(filter) {
    const target = filter && filter.measure;
    if (!target) {
      return undefined;
    }
    return this.measures.find(
      (m) => m.measure === target || m.expressionName === target
    );
  },

  /**
   * 当 measure filter 引用 period_average（窗口函数）指标时，将内层 GROUP BY 查询
   * 包成子查询，filter 从 HAVING 改写到外层 WHERE（引用内层投影别名）。
   *
   * 窗口函数结果在内层已物化为一列，外层 WHERE 引用别名对所有数据库均合法。
   * 复用半累加 q_0 包装模式。ORDER BY / LIMIT 由调用方拼接到返回值之后（外层）。
   *
   * @param {string} innerQuery 内层查询（含 GROUP BY，不含 HAVING/ORDER BY/LIMIT）
   * @param {string[]} [innerColumns] 内层投影别名列表，默认取 periodAverageOuterSelectAliases()
   * @returns {string} `SELECT <cols> FROM (<innerQuery>) AS <alias> [WHERE ...]`
   */
  wrapWithOuterMeasureFilters(innerQuery, innerColumns) {
    const columns = innerColumns || this.periodAverageOuterSelectAliases();
    const outerAlias = this.escapeColumnName(this.aliasName('q_pa'));
    const selectList = columns.map((c) => `${outerAlias}.${c}`).join(', ');
    const whereClause = this.measureFilters
      .map((f) => {
        const measure = this.findMeasureForFilter(f);
        // 外层引用内层投影的 measure 别名；非 measure filter（不应出现于此）兜底用 filterToWhere
        if (measure && typeof measure.aliasName === 'function') {
          const columnSql = `${outerAlias}.${measure.aliasName()}`;
          return f.conditionSql ? `(${f.conditionSql(columnSql)})` : null;
        }
        const w = f.filterToWhere ? f.filterToWhere() : null;
        return w ? `(${w})` : null;
      })
      .filter(R.identity)
      .join(' AND ');
    const asSyntax = this.asSyntaxJoin ? `${this.asSyntaxJoin} ` : '';
    let sql = `SELECT ${selectList} FROM (${innerQuery}) ${asSyntax}${outerAlias}`;
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }
    return sql;
  },
};
