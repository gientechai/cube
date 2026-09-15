/**
 * Semi-additive (point-in-time / nonAdditiveDimension) query capability.
 *
 * Installed onto BaseQuery.prototype via installQueryCapabilities — method names
 * stay on `this` so dialects (e.g. GBaseQuery.allocateSemiAdditiveCteNames)
 * and BaseMeasure keep working.
 *
 * New query features should land under adapter/capabilities/, not BaseQuery.js.
 */
import R from 'ramda';

import { UserError } from '../../compiler/UserError';

export const SemiAdditiveCapability = {
  /**
   * 生成半累加指标的条件聚合 SQL
   * 默认实现使用 FILTER 语法（PostgreSQL 风格）
   *
   * 子类可以重写此方法以支持不支持 FILTER 的数据库（如 MSSQL, Oracle）
   *
   * @param {string} aggregateExpr - 聚合表达式，如 'SUM(balance)'
   * @param {string} condition - 过滤条件，如 'balance = max_balance_window'
   * @returns {string} 条件聚合 SQL
   */
  semiAdditiveAggregateFilter(aggregateExpr, condition) {
    return `${aggregateExpr} FILTER (WHERE ${condition})`;
  },

  /**
   * 生成窗口函数 SQL
   *
   * @param {string} funcName - 窗口函数名，如 'MAX', 'MIN'
   * @param {string} expr - 表达式，如 'balance'
   * @param {string} partitionBy - PARTITION BY 子句
   * @param {string} [orderBy=''] - ORDER BY 子句（可选）
   * @returns {string} 窗口函数 SQL
   */
  semiAdditiveWindowFunction(funcName, expr, partitionBy, orderBy = '') {
    const orderByClause = orderBy ? ` ORDER BY ${orderBy}` : '';
    return `${funcName}(${expr}) OVER (${partitionBy}${orderByClause})`;
  },

  /**
   * 检查数据库是否支持 FILTER 语法
   * 默认为 true，子类可以重写
   *
   * @returns {boolean}
   */
  supportsFilterClause() {
    return true;
  },

  /**
   * 检查是否有半累加指标
   *
   * @param {BaseMeasure[]} measures
   * @returns {boolean}
   */
  hasSemiAdditiveMeasures(measures) {
    return measures && measures.some((m) => {
      const measurePath = m?.expressionPath && m.expressionPath();
      return measurePath && this.shouldUseSemiAdditiveAggregationForMeasurePath(measurePath);
    });
  },

  semiAdditiveOuterSqlReferencesMainCubeAlias(sql) {
    return typeof sql === 'string' && /\bmain__\w+/i.test(sql);
  },

  directSemiAdditiveMeasurePathsInQuery(measures = this.measures) {
    return new Set(
      (measures || [])
        .filter(m => typeof m.isSemiAdditive === 'function' && m.isSemiAdditive())
        .map(m => m.expressionPath && m.expressionPath())
        .filter(Boolean),
    );
  },

  /**
   * period_average 分子展开时点型基础 measure 时，应像普通 measure 一样 SUM/AVG，
   * 而不是半累加的期初/期末窗口取值。
   *
   * @param {BaseMeasure} measure
   * @returns {boolean}
   */
  shouldUseSemiAdditiveAggregation(measure) {
    if (!measure || typeof measure.isSemiAdditive !== 'function' || !measure.isSemiAdditive()) {
      return false;
    }

    if (this.safeEvaluateSymbolContext().periodAverageNumerator) {
      return false;
    }

    const measurePath = measure.expressionPath && measure.expressionPath();
    if (!measurePath) {
      return true;
    }

    return this.shouldUseSemiAdditiveAggregationForMeasurePath(measurePath);
  },

  /**
   * @param {string} measurePath
   * @returns {boolean}
   */
  shouldUseSemiAdditiveAggregationForMeasurePath(measurePath) {
    if (!measurePath || !this.cubeEvaluator.isMeasure(measurePath)) {
      return false;
    }

    let measure;
    try {
      measure = this.newMeasure(measurePath);
    } catch (e) {
      return false;
    }

    if (!measure.isSemiAdditive()) {
      return false;
    }

    const periodAverageBases = this.periodAverageBaseMeasurePathsInQuery();
    const directSemiAdditive = this.directSemiAdditiveMeasurePathsInQuery();

    if (periodAverageBases.has(measurePath) && !directSemiAdditive.has(measurePath)) {
      return false;
    }

    return true;
  },

  /**
   * 半累加 CTE 外层会通过 renderedReference 复用已投影的半累加指标 SQL。
   * period_average 分子展开时点型基础 measure 时须跳过该引用，改用普通 SUM/AVG。
   *
   * @param {string} measurePath
   * @returns {boolean}
   */
  shouldUseRenderedReferenceForMeasurePath(measurePath) {
    if (!this.safeEvaluateSymbolContext().periodAverageNumerator) {
      return true;
    }

    if (!measurePath || !this.cubeEvaluator.isMeasure(measurePath)) {
      return true;
    }

    try {
      const measure = this.newMeasure(measurePath);
      return !(typeof measure.isSemiAdditive === 'function' && measure.isSemiAdditive());
    } catch (e) {
      return true;
    }
  },

  /**
   * 收集查询指标及其计算表达式递归引用到的半累加指标。
   *
   * @param {BaseMeasure[]} measures
   * @param {Array<BaseFilter>} filters
   * @returns {BaseMeasure[]}
   */
  collectReferencedSemiAdditiveMeasures(measures, filters = []) {
    const explicitMeasurePaths = (measures || [])
      .map(m => m.expressionPath && m.expressionPath())
      .filter(Boolean);

    let referencedMemberPaths = [];
    try {
      referencedMemberPaths = this.collectFrom(
        (measures || []).concat(filters || []),
        this.collectMemberNamesFor.bind(this),
        'collectMemberNamesFor',
      );
    } catch (e) {
      referencedMemberPaths = [];
    }

    return R.uniq(explicitMeasurePaths.concat(referencedMemberPaths))
      .filter(path => path && this.cubeEvaluator.isMeasure(path))
      .map((path) => {
        try {
          return this.newMeasure(path);
        } catch (e) {
          return null;
        }
      })
      .filter(m => m && m.isSemiAdditive && m.isSemiAdditive())
      .filter(m => this.shouldUseSemiAdditiveAggregationForMeasurePath(m.expressionPath()));
  },

  /**
   * True if the current query lists any semi-additive measure (nonAdditiveDimension).
   * Used with `this.from` so multi-stage subqueries still run regularMeasuresSubQuery.
   */
  queryHasSemiAdditiveMeasures() {
    return (this.measures || []).some((m) => {
      const measurePath = m?.expressionPath && m.expressionPath();
      return measurePath && this.shouldUseSemiAdditiveAggregationForMeasurePath(measurePath);
    });
  },

  /**
   * True if any measure referenced by the query (including via calculated / multi-stage SQL) is semi-additive.
   * Used so Tesseract falls back when the user selects only e.g. `m - m_last_year` while `m` has nonAdditiveDimension.
   */
  queryReferencesSemiAdditiveMeasures() {
    let names;
    try {
      names = this.collectAllMemberNames();
    } catch (e) {
      return false;
    }
    if (!names || !names.length) {
      return false;
    }
    return names.some((path) => this.shouldUseSemiAdditiveAggregationForMeasurePath(path));
  },

  /**
   * Unique key for projecting a dimension into semi-additive base_data/windowed_data.
   * Time dimensions with different granularities share expressionPath() but need
   * separate columns (e.g. distr_date day + month).
   *
   * @param {*} dimension
   * @returns {string|null}
   */
  semiAdditiveDimensionProjectionKey(dimension) {
    const path = dimension.expressionPath && dimension.expressionPath();
    if (!path) {
      return null;
    }
    const granularity = dimension.granularity;
    return granularity ? `${path}.${granularity}` : path;
  },

  /**
   * 在半累加 CTE（base_data / windowed_data）上构建指标查询。
   * regularMeasuresSubQuery 与 aggregateSubQuery（multiplied + 跨 cube 过滤）共用。
   *
   * @param {BaseMeasure[]} measures
   * @param {Array<BaseFilter>} filters
   * @param {string} baseFromSql
   * @param {{
   *   skipBaseWhere?: boolean,
   *   inlineWhereConditions?: string[],
   *   dimensionSourceAlias?: string,
   * }} [options]
   * @returns {string}
   */
  buildSemiAdditiveMeasuresQuery(measures, filters, baseFromSql, options = {}) {
    const {
      skipBaseWhere = false,
      inlineWhereConditions = [],
      dimensionSourceAlias,
    } = options;

    const semiAdditiveMeasuresForCte = this.collectReferencedSemiAdditiveMeasures(measures, filters);

    const unaggregatedColumns = [];
    const pushedDimensionPaths = new Set();
    const dimensionsForSemiAdditiveRemap = [];

    const pushDimensionColumns = (d) => {
      const path = this.semiAdditiveDimensionProjectionKey(d);
      if (!path || pushedDimensionPaths.has(path)) {
        return;
      }
      pushedDimensionPaths.add(path);
      const cols = d.selectColumns && d.selectColumns();
      if (cols) {
        cols.forEach(col => unaggregatedColumns.push(col));
      }
      dimensionsForSemiAdditiveRemap.push(d);
    };

    if (dimensionSourceAlias) {
      this.dimensionsForSelect().forEach((d) => {
        const path = this.semiAdditiveDimensionProjectionKey(d);
        if (!path || pushedDimensionPaths.has(path)) {
          return;
        }
        // timeDimension 仅 dateRange（无 granularity）时 aliasName() 为 null；
        // 不可投影成 `${keys}.null as null`（JS 模板会把 null 拼成字面量 "null"）。
        const alias = d.aliasName && d.aliasName();
        if (!alias) {
          return;
        }
        pushedDimensionPaths.add(path);
        // Project keys columns under flat aliases so windowed_data can reference them
        // (base_data has no `keys` table alias — only the projected column names).
        unaggregatedColumns.push(`${dimensionSourceAlias}.${alias} as ${alias}`);
        dimensionsForSemiAdditiveRemap.push(d);
      });
    } else {
      this.dimensionsForSelect().forEach(pushDimensionColumns);
    }

    // aggregateSubQuery 的 keys 子查询已应用跨 cube 过滤；filter 维度不在 keys+fact join 中，勿注入 base_data。
    const implicitDimensionPaths = dimensionSourceAlias
      ? []
      : R.uniq(
        this.collectFrom(
          measures.concat(semiAdditiveMeasuresForCte).concat(filters),
          this.collectMemberNamesFor.bind(this),
          'collectMemberNamesFor',
        ).filter((p) => this.cubeEvaluator.isDimension(p))
      );
    implicitDimensionPaths.forEach((p) => {
      if (!pushedDimensionPaths.has(p)) {
        pushDimensionColumns(this.newDimension(p));
      }
    });

    // windowGroupings 维度必须出现在 base_data，否则 windowed_data 的 PARTITION BY 引用不存在的列别名
    semiAdditiveMeasuresForCte.forEach((measure) => {
      const config = measure.nonAdditiveConfig;
      if (!config?.windowGroupings?.length) {
        return;
      }
      const cubeName = measure.cube().name;
      config.windowGroupings.forEach((grouping) => {
        const groupingPath = grouping.includes('.') ? grouping : `${cubeName}.${grouping}`;
        const dim = this.newDimension(groupingPath);
        const path = this.semiAdditiveDimensionProjectionKey(dim);
        if (!path || pushedDimensionPaths.has(path)) {
          return;
        }
        pushDimensionColumns(dim);
      });
    });

    semiAdditiveMeasuresForCte.forEach(measure => {
      const baseSql = this.semiAdditiveMeasureRawSql(measure);
      const rawColumnName = `_${measure.unescapedAliasName()}_raw`;
      unaggregatedColumns.push(`${baseSql} as ${this.escapeColumnName(rawColumnName)}`);
    });

    this.queryPeriodAverageMeasures(measures).forEach((paMeasure) => {
      const baseSql = this.periodAverageSemiAdditiveBaseRawSql(paMeasure);
      if (!baseSql) {
        return;
      }
      unaggregatedColumns.push(
        `${baseSql} as ${this.periodAverageSemiAdditiveBaseColumnAlias(paMeasure)}`,
      );
    });

    const timeDimensionsForOrdering = new Set();

    semiAdditiveMeasuresForCte.forEach(measure => {
      const config = measure.nonAdditiveConfig;
      if (config && config.name) {
        timeDimensionsForOrdering.add(config.name);
      }
    });

    if (semiAdditiveMeasuresForCte.length > 0) {
      const contextMeasure = semiAdditiveMeasuresForCte[0];
      timeDimensionsForOrdering.forEach(dimensionName => {
        const cubeName = contextMeasure.cube().name;
        const dimensionPath = dimensionName.includes('.') ? dimensionName : `${cubeName}.${dimensionName}`;
        const dimension = this.newDimension(dimensionPath);
        // Layer B: ordering 用裸列（不做 CONVERT_TZ），MAX/MIN 比较更便宜且语义与同偏移 TZ 一致
        const orderingSql = this.semiAdditiveOrderingColumnSql(dimension);
        const unescapedAlias = dimension.unescapedAliasName();
        const columnAlias = `_${unescapedAlias}_for_ordering`;
        unaggregatedColumns.push(`${orderingSql} as ${this.escapeColumnName(columnAlias)}`);
      });
    }

    measures.filter((m) => {
      if (m.isSemiAdditive && m.isSemiAdditive()) {
        return false;
      }
      if (this.isPeriodAverageMeasure(m)) {
        return false;
      }
      return true;
    }).forEach((measure) => {
      const def = measure.measureDefinition();
      const baseSql = def && def.sql;
      if (baseSql == null || baseSql === '') {
        return;
      }
      const evaluatedBase = this.evaluateSql(measure.cube().name, baseSql);
      if (evaluatedBase == null) {
        return;
      }
      const rawStr = String(evaluatedBase).trim();
      if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(rawStr)) {
        return;
      }
      const prefixed = `${this.cubeAlias(measure.cube().name)}.${rawStr}`;
      const colAlias = `_${measure.unescapedAliasName()}_measure_base`;
      unaggregatedColumns.push(`${prefixed} as ${this.escapeColumnName(colAlias)}`);
    });

    const whereClause = skipBaseWhere
      ? ''
      : ` ${this.baseWhere(filters.concat(inlineWhereConditions))}`;
    const innerQuery = `SELECT ${unaggregatedColumns.join(', ')} FROM ${baseFromSql}${whereClause}`;

    return this.buildSemiAdditiveCTEQuery(
      innerQuery,
      measures,
      unaggregatedColumns,
      timeDimensionsForOrdering,
      dimensionsForSemiAdditiveRemap,
      semiAdditiveMeasuresForCte,
    );
  },

  /**
   * 将非半累加指标 SQL 中的主表限定列替换为 windowed_data 中的投影列别名。
   *
   * @param {*} measure
   * @param {string} sql
   * @returns {string}
   */
  rewriteSemiAdditiveOuterMeasureSql(measure, sql) {
    if (this.isPeriodAverageMeasure(measure)) {
      const basePath = this.periodAverageBaseMeasurePath(measure);
      if (basePath) {
        const baseMeasure = this.newMeasure(basePath);
        const baseDef = baseMeasure.measureDefinition();
        const baseEvaluated = baseDef?.sql && this.evaluateSql(baseMeasure.cube().name, baseDef.sql);
        if (baseEvaluated != null) {
          const rawStr = String(baseEvaluated).trim();
          const cubeAlias = this.cubeAlias(baseMeasure.cube().name);
          const replacement = this.periodAverageSemiAdditiveBaseColumnAlias(measure);
          const prefixedUnquoted = `${cubeAlias}.${rawStr}`;
          if (sql.includes(prefixedUnquoted)) {
            return sql.split(prefixedUnquoted).join(replacement);
          }
          const prefixedQuoted = `${cubeAlias}.${this.escapeColumnName(rawStr)}`;
          if (sql.includes(prefixedQuoted)) {
            return sql.split(prefixedQuoted).join(replacement);
          }
        }
      }
      return sql;
    }

    const def = measure.measureDefinition();
    const baseSql = def && def.sql;
    if (baseSql == null || baseSql === '') {
      return sql;
    }
    const evaluatedBase = this.evaluateSql(measure.cube().name, baseSql);
    if (evaluatedBase == null) {
      return sql;
    }
    const rawStr = String(evaluatedBase).trim();
    if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(rawStr)) {
      return sql;
    }
    const replacement = this.escapeColumnName(`_${measure.unescapedAliasName()}_measure_base`);
    const cubeAlias = this.cubeAlias(measure.cube().name);
    const prefixedUnquoted = `${cubeAlias}.${rawStr}`;
    if (sql.includes(prefixedUnquoted)) {
      return sql.split(prefixedUnquoted).join(replacement);
    }
    const prefixedQuoted = `${cubeAlias}.${this.escapeColumnName(rawStr)}`;
    if (sql.includes(prefixedQuoted)) {
      return sql.split(prefixedQuoted).join(replacement);
    }
    return sql;
  },

  /**
   * 生成半累加 CTE base_data 中的原始 measure 列 SQL。
   *
   * 不能走完整的 evaluateSymbolSql(..., 'measure')，否则像 `balance * 2` 会被误判为成员引用，
   * 且会提前套上聚合。这里只 evaluate 原始 sql 并应用 schema filters（与普通 measure 一致）。
   *
   * @param {BaseMeasure} measure
   * @returns {string}
   */
  semiAdditiveMeasureRawSql(measure) {
    return this.rawMeasureSql(measure);
  },

  /**
   * 为半累加指标构建 CTE 重写的查询。
   * max/min/first/last 优先走 partition_bounds + JOIN（避免对全量行做窗口函数）；
   * avg 等场景回退到 windowed_data + OVER。
   *
   * @param {string} originalQuery - 未聚合的内部查询
   * @param {BaseMeasure[]} measures - 所有measures
   * @param {string[]} baseColumns - 基础列的 SELECT 表达式列表（维度 + 原始数据列）
   * @param {string[]} timeDimensionsForOrdering - 用于 ORDER BY 的时间维度名称列表
   * @param {unknown[]} [dimensionsForSemiAdditiveRemap] - 需映射到列别名的维度（含 measure 隐式依赖）
   * @param {BaseMeasure[]} [semiAdditiveMeasuresForCte] - CTE 中需要投影的半累加指标（含隐式依赖）
   * @returns {string} 重写后的CTE查询
   */
  buildSemiAdditiveCTEQuery(
    originalQuery,
    measures,
    baseColumns,
    timeDimensionsForOrdering = [],
    dimensionsForSemiAdditiveRemap = [],
    semiAdditiveMeasuresForCte = null,
  ) {
    const semiAdditiveMeasures = semiAdditiveMeasuresForCte ||
      measures.filter((m) => {
        const measurePath = m?.expressionPath && m.expressionPath();
        return measurePath && this.shouldUseSemiAdditiveAggregationForMeasurePath(measurePath);
      });

    if (semiAdditiveMeasures.length === 0) {
      return originalQuery;
    }

    if (this.canUseSemiAdditiveJoinPath(semiAdditiveMeasures)) {
      return this.buildSemiAdditiveJoinQuery(
        originalQuery,
        measures,
        baseColumns,
        timeDimensionsForOrdering,
        dimensionsForSemiAdditiveRemap,
        semiAdditiveMeasures,
      );
    }

    return this.buildSemiAdditiveWindowQuery(
      originalQuery,
      measures,
      baseColumns,
      timeDimensionsForOrdering,
      dimensionsForSemiAdditiveRemap,
      semiAdditiveMeasures,
    );
  },

  /**
   * max/min/first/last 可用 GROUP BY + JOIN 等价替换窗口函数；avg 需保留 OVER。
   *
   * @param {BaseMeasure[]} semiAdditiveMeasures
   * @returns {boolean}
   */
  canUseSemiAdditiveJoinPath(semiAdditiveMeasures) {
    if (!semiAdditiveMeasures || !semiAdditiveMeasures.length) {
      return false;
    }
    const joinCompatible = ['max', 'min', 'first', 'last'];
    return semiAdditiveMeasures.every((measure) => {
      const config = measure.nonAdditiveConfig;
      if (!config || !config.windowChoice) {
        return false;
      }
      return joinCompatible.includes(config.windowChoice);
    });
  },

  /**
   * Layer B: 半累加 ordering 列尽量用维度裸 SQL（不做 CONVERT_TZ）。
   * 同一偏移下 MAX/MIN 选型不变，但全量扫描时少一轮时区转换。
   *
   * @param {*} dimension
   * @returns {string}
   */
  semiAdditiveOrderingColumnSql(dimension) {
    try {
      const def = dimension.dimensionDefinition && dimension.dimensionDefinition();
      if (def && def.sql) {
        const cubeName = dimension.path()[0];
        return this.autoPrefixWithCubeName(
          cubeName,
          this.evaluateSql(cubeName, def.sql),
          false,
        );
      }
    } catch (e) {
      // fall through
    }
    return this.dimensionSql(dimension);
  },

  /**
   * 提取 baseColumns 中的列别名列表。
   *
   * @param {string[]} baseColumns
   * @returns {string[]}
   */
  semiAdditiveBaseColumnAliases(baseColumns) {
    return baseColumns.map(colExpr => {
      const asMatch = colExpr.match(/ as\s+(\S+?)$/i);
      let alias;
      if (asMatch) {
        alias = asMatch[1].trim();
      } else {
        const parts = colExpr.split(/\s+/);
        alias = parts[parts.length - 1];
      }
      alias = this.unquotedColumnName(alias);
      return alias ? this.escapeColumnName(alias) : null;
    }).filter(alias => alias);
  },

  /**
   * 构建半累加最终 SELECT 的维度/指标列（JOIN / Window 路径共用）。
   *
   * @param {BaseMeasure[]} measures
   * @param {BaseMeasure[]} semiAdditiveMeasures
   * @param {unknown[]} dimensionsForSemiAdditiveRemap
   * @returns {{ dimensionColumns: string[], selectColumns: string, groupByClause: string }}
   */
  buildSemiAdditiveOuterSelect(measures, semiAdditiveMeasures, dimensionsForSemiAdditiveRemap) {
    const renderedRefFromDims = R.fromPairs(
      (dimensionsForSemiAdditiveRemap || [])
        .filter(d => d.expressionPath && d.aliasName && d.aliasName())
        .map(d => [d.expressionPath(), d.aliasName()])
    );

    const renderedRefFromSemiAdditiveMeasures = R.fromPairs(
      semiAdditiveMeasures.map((m) => [m.measure, m.measureSql()])
    );

    const semiAdditiveCteRenderedReference = {
      ...renderedRefFromDims,
      ...renderedRefFromSemiAdditiveMeasures,
    };

    // 时间维度无 granularity（仅 dateRange 用于过滤）时 aliasName() 返回 null，
    // 它们不参与半累加最终 SELECT/GROUP BY 的投影。过滤掉空别名，避免生成
    // 形如 `SELECT , <measure>` / `GROUP BY ` 的非法 SQL。
    const dimensionColumns = this.dimensionsForSelect().map(d => d.aliasName()).filter(Boolean);
    const measureColumns = measures.map(m => {
      if (this.shouldUseSemiAdditiveAggregation(m)) {
        // 半累加指标：使用 measureSql() 生成聚合表达式
        const sql = m.measureSql();
        const alias = m.aliasName();
        return `${sql} as ${alias}`;
      }
      if (this.isPeriodAverageMeasure(m)) {
        const rendered = this.renderPeriodAverageSemiAdditiveMeasureSql(m);
        if (rendered) {
          return rendered;
        }
      }
      const sql = this.evaluateSymbolSqlWithContext(
        () => m.measureSql(),
        { renderedReference: semiAdditiveCteRenderedReference },
      );
      let rewritten = this.rewriteSemiAdditiveOuterMeasureSql(m, sql);
      if (this.semiAdditiveOuterSqlReferencesMainCubeAlias(rewritten) && this.isPeriodAverageMeasure(m)) {
        const rendered = this.renderPeriodAverageSemiAdditiveMeasureSql(m);
        if (rendered) {
          return rendered;
        }
      }
      if (this.semiAdditiveOuterSqlReferencesMainCubeAlias(rewritten)) {
        throw new UserError(
          `Measure '${m.measure}' references the base table inside semi-additive windowed_data aggregation. `
          + 'Ensure period_average is configured on this measure and recompile the schema.',
        );
      }
      return `${rewritten} as ${m.aliasName()}`;
    });
    const selectColumns = [...dimensionColumns, ...measureColumns].join(', ');
    const groupByClause = (this.ungrouped || !dimensionColumns.length)
      ? ''
      : ` GROUP BY ${dimensionColumns.join(', ')}`;

    return { dimensionColumns, selectColumns, groupByClause };
  },

  /**
   * 解析 partition 表达式列表（不含 PARTITION BY 关键字）。
   * 直接复用 buildSemiAdditivePartitionBy 的 clauses 构建逻辑，避免按逗号拆分破坏 DATE_FORMAT 等表达式。
   *
   * @param {BaseMeasure} measure
   * @param {object} config
   * @param {string[]|Set} timeDimensionsForOrdering
   * @returns {string[]}
   */
  buildSemiAdditivePartitionExprs(measure, config, timeDimensionsForOrdering = []) {
    return this.collectSemiAdditivePartitionClauses(measure, config, timeDimensionsForOrdering);
  },

  /**
   * 收集半累加 PARTITION BY / bounds GROUP BY 表达式（有序数组）。
   *
   * @param {BaseMeasure} measure
   * @param {object} config
   * @param {string[]|Set} timeDimensionsForOrdering
   * @returns {string[]}
   */
  collectSemiAdditivePartitionClauses(measure, config, timeDimensionsForOrdering = []) {
    const clauses = [];
    const cubeName = measure.cube().name;
    const dimensionPath = config.name.includes('.') ? config.name : `${cubeName}.${config.name}`;

    const queryTimeDimensions = this.timeDimensions || [];

    const matchingTimeDims = queryTimeDimensions.filter(td => {
      const tdPath = td.dimension || `${td.cube ? td.cube().name : cubeName}.${td.name}`;
      return tdPath === dimensionPath || tdPath.endsWith(`.${config.name}`);
    });

    let finestGranularity = null;
    matchingTimeDims.forEach((td) => {
      if (td.granularity) {
        finestGranularity = finestGranularity
          ? this.minGranularity(finestGranularity, td.granularity)
          : td.granularity;
      }
    });

    if (finestGranularity) {
      const dimension = this.newDimension(dimensionPath);
      const unescapedAlias = dimension.unescapedAliasName();
      const columnAlias = `_${unescapedAlias}_for_ordering`;
      const escapedColumnAlias = this.escapeColumnName(columnAlias);

      const timeGroupedSql = this.timeGroupedColumn(finestGranularity, escapedColumnAlias);
      clauses.push(timeGroupedSql);
    }

    if (config.windowGroupings) {
      config.windowGroupings.forEach(grouping => {
        const groupingPath = grouping.includes('.') ? grouping : `${cubeName}.${grouping}`;
        const dimensionAlias = this.aliasName(groupingPath);
        clauses.push(this.escapeColumnName(dimensionAlias));
      });
    }

    return clauses;
  },

  /**
   * windowChoice → MIN/MAX 聚合函数。
   *
   * @param {string} windowChoice
   * @returns {'MIN'|'MAX'}
   */
  semiAdditiveBoundaryAggFunc(windowChoice) {
    const ascendingChoices = ['first', 'min'];
    return ascendingChoices.includes(windowChoice) ? 'MIN' : 'MAX';
  },

  /**
   * NULL-safe 等值（与窗口 PARTITION BY NULL 行为一致）。
   * 标准 SQL：`a = b OR (a IS NULL AND b IS NULL)`，全库通用。
   *
   * @param {string} leftSql
   * @param {string} rightSql
   * @returns {string}
   */
  semiAdditiveNullSafeEqual(leftSql, rightSql) {
    return `((${leftSql}) = (${rightSql}) OR ((${leftSql}) IS NULL AND (${rightSql}) IS NULL))`;
  },

  /**
   * CTE names for semi-additive join/window paths.
   * Dialects that flatten nested WITH scopes (e.g. GBase) override this to allocate unique names.
   */
  allocateSemiAdditiveCteNames() {
    return {
      base: 'base_data',
      matched: 'matched_data',
      windowed: 'windowed_data',
      partitionBounds: (groupIndex) => `partition_bounds_${groupIndex}`,
    };
  },

  /**
   * Layer A: partition_bounds（GROUP BY 求边界）+ JOIN，替代全量窗口函数。
   * 边界列名仍为 `${alias}_min_ds`，与 BaseMeasure.semiAdditiveMeasureSql 兼容。
   */
  buildSemiAdditiveJoinQuery(
    originalQuery,
    measures,
    baseColumns,
    timeDimensionsForOrdering = [],
    dimensionsForSemiAdditiveRemap = [],
    semiAdditiveMeasures = [],
  ) {
    const cteNames = this.allocateSemiAdditiveCteNames();
    const baseColumnAliases = this.semiAdditiveBaseColumnAliases(baseColumns);
    const { selectColumns, groupByClause } = this.buildSemiAdditiveOuterSelect(
      measures,
      semiAdditiveMeasures,
      dimensionsForSemiAdditiveRemap,
    );

    // 按 partition 签名分组，同分区的 max/min 合并进一个 bounds CTE
    const partitionGroups = [];
    const groupKeyToIndex = new Map();

    semiAdditiveMeasures.forEach((measure) => {
      const config = measure.nonAdditiveConfig;
      if (!config) {
        return;
      }
      const timeDimColumn = this.getSemiAdditiveTimeDimensionColumn(
        measure,
        config,
        timeDimensionsForOrdering,
      );
      if (!timeDimColumn) {
        return;
      }
      const partitionExprs = this.buildSemiAdditivePartitionExprs(
        measure,
        config,
        timeDimensionsForOrdering,
      );
      const signature = partitionExprs.join('\u0001');
      let groupIndex = groupKeyToIndex.get(signature);
      if (groupIndex == null) {
        groupIndex = partitionGroups.length;
        groupKeyToIndex.set(signature, groupIndex);
        partitionGroups.push({
          partitionExprs,
          boundaries: [],
        });
      }
      const aggFunc = this.semiAdditiveBoundaryAggFunc(config.windowChoice);
      const boundaryAlias = this.escapeColumnName(`${measure.unescapedAliasName()}_min_ds`);
      partitionGroups[groupIndex].boundaries.push({
        measure,
        timeDimColumn,
        aggFunc,
        boundaryAlias,
      });
    });

    // 无可用 boundary（缺少 ordering 列）时回退窗口路径
    if (!partitionGroups.length || partitionGroups.every(g => !g.boundaries.length)) {
      return this.buildSemiAdditiveWindowQuery(
        originalQuery,
        measures,
        baseColumns,
        timeDimensionsForOrdering,
        dimensionsForSemiAdditiveRemap,
        semiAdditiveMeasures,
      );
    }

    const boundsCteParts = [];
    const joinClauses = [];
    const boundarySelectAliases = [];

    partitionGroups.forEach((group, groupIndex) => {
      const boundsAlias = cteNames.partitionBounds(groupIndex);
      const partitionSelectParts = group.partitionExprs.map((expr, i) => (
        `${expr} as ${this.escapeColumnName(`__sa_p${groupIndex}_${i}`)}`
      ));
      const boundarySelectParts = group.boundaries.map((b) => (
        `${b.aggFunc}(${b.timeDimColumn}) as ${b.boundaryAlias}`
      ));
      const selectParts = partitionSelectParts.concat(boundarySelectParts);
      const groupByClauseBounds = group.partitionExprs.length
        ? ` GROUP BY ${group.partitionExprs.join(', ')}`
        : '';

      boundsCteParts.push(
        `${boundsAlias} AS (\n  SELECT ${selectParts.join(', ')}\n  FROM ${cteNames.base}${groupByClauseBounds}\n)`
      );

      if (group.partitionExprs.length) {
        // NULL-safe：分区键为 NULL 时仍匹配（与窗口 PARTITION BY NULL 行为一致）
        const nullSafeOnParts = group.partitionExprs.map((expr, i) => {
          const pbCol = `${boundsAlias}.${this.escapeColumnName(`__sa_p${groupIndex}_${i}`)}`;
          return this.semiAdditiveNullSafeEqual(expr, pbCol);
        });
        joinClauses.push(`INNER JOIN ${boundsAlias} ON ${nullSafeOnParts.join(' AND ')}`);
      } else {
        // 无 PARTITION BY → 全局边界，CROSS JOIN 单行
        joinClauses.push(`CROSS JOIN ${boundsAlias}`);
      }

      group.boundaries.forEach((b) => {
        boundarySelectAliases.push(
          `${boundsAlias}.${b.boundaryAlias} as ${b.boundaryAlias}`
        );
      });
    });

    const matchedSelect = [
      ...baseColumnAliases.map(a => `${cteNames.base}.${a}`),
      ...boundarySelectAliases,
    ].join(', ');

    const cteQuery = `WITH ${cteNames.base} AS (
  ${originalQuery}
), ${boundsCteParts.join(',\n')}, ${cteNames.matched} AS (
  SELECT ${matchedSelect}
  FROM ${cteNames.base}
  ${joinClauses.join('\n  ')}
)
SELECT ${selectColumns} FROM ${cteNames.matched}${groupByClause}`;

    return cteQuery;
  },

  /**
   * Layer D / fallback: 原 windowed_data + OVER 路径。
   */
  buildSemiAdditiveWindowQuery(
    originalQuery,
    measures,
    baseColumns,
    timeDimensionsForOrdering = [],
    dimensionsForSemiAdditiveRemap = [],
    semiAdditiveMeasures = [],
  ) {
    const windowExpressions = semiAdditiveMeasures.flatMap(measure => {
      const config = measure.nonAdditiveConfig;
      if (!config) return [];

      const partitionBy = this.buildSemiAdditivePartitionBy(measure, config, timeDimensionsForOrdering);
      const timeDimColumn = this.getSemiAdditiveTimeDimensionColumn(measure, config, timeDimensionsForOrdering);

      if (!timeDimColumn) {
        return [];
      }

      const windowColumnName = this.escapeColumnName(`${measure.unescapedAliasName()}_min_ds`);
      const ascendingChoices = ['first', 'min'];
      const descendingChoices = ['last', 'max'];

      let timeWindowFunc;
      if (ascendingChoices.includes(config.windowChoice)) {
        timeWindowFunc = `MIN(${timeDimColumn}) OVER (${partitionBy})`;
      } else if (descendingChoices.includes(config.windowChoice)) {
        timeWindowFunc = `MAX(${timeDimColumn}) OVER (${partitionBy})`;
      } else {
        timeWindowFunc = `MIN(${timeDimColumn}) OVER (${partitionBy})`;
      }

      return [
        `${timeWindowFunc} as ${windowColumnName}`,
      ];
    });

    const cteNames = this.allocateSemiAdditiveCteNames();
    const baseColumnAliases = this.semiAdditiveBaseColumnAliases(baseColumns);
    const { selectColumns, groupByClause } = this.buildSemiAdditiveOuterSelect(
      measures,
      semiAdditiveMeasures,
      dimensionsForSemiAdditiveRemap,
    );

    return `WITH ${cteNames.base} AS (
  ${originalQuery}
), ${cteNames.windowed} AS (
  SELECT ${baseColumnAliases.join(', ')}, ${windowExpressions.join(', ')}
  FROM ${cteNames.base}
)
SELECT ${selectColumns} FROM ${cteNames.windowed}${groupByClause}`;
  },

  /**
   * 为半累加指标构建 PARTITION BY 子句
   *
   * @param {BaseMeasure} measure
   * @param {NonAdditiveDimensionConfig} config
   * @returns {string}
   */
  buildSemiAdditivePartitionBy(measure, config, timeDimensionsForOrdering = []) {
    const clauses = this.collectSemiAdditivePartitionClauses(
      measure,
      config,
      timeDimensionsForOrdering,
    );
    return clauses.length > 0 ? `PARTITION BY ${clauses.join(', ')}` : '';
  },

  /**
   * 为半累加指标构建 ORDER BY 子句
   * 基于非可加时间维度排序，使窗口函数能正确选择时点值
   *
   * @param {BaseMeasure} measure
   * @param {NonAdditiveDimensionConfig} config
   * @param {string[]} timeDimensionsForOrdering - 用于 ORDER BY 的时间维度名称列表
   * @returns {string} ORDER BY 子句（如 "ORDER BY ds ASC" 或 "ORDER BY ds DESC"）
   */
  buildSemiAdditiveOrderBy(measure, config, timeDimensionsForOrdering = []) {
    // 检查是否在时间维度列表中（支持 Set 和 Array）
    const hasDimension = typeof timeDimensionsForOrdering.has === 'function'
      ? timeDimensionsForOrdering.has(config.name)
      : timeDimensionsForOrdering.includes(config.name);

    if (!hasDimension) {
      return ''; // 如果没有对应的时间维度列，不添加 ORDER BY
    }

    // 使用 CTE 中的列别名（格式：_dimensionAlias_for_ordering）
    const cubeName = measure.cube().name;
    const dimensionPath = config.name.includes('.') ? config.name : `${cubeName}.${config.name}`;
    const dimension = this.newDimension(dimensionPath);
    // 获取不带引号的别名
    const unescapedAlias = dimension.unescapedAliasName();
    const columnAlias = this.escapeColumnName(`_${unescapedAlias}_for_ordering`);

    // 根据 windowChoice 决定排序方向：
    // - first/min: 时间升序（ASC），取最早时间的值
    // - last/max: 时间降序（DESC），取最晚时间的值
    const ascendingChoices = ['first', 'min'];
    const descendingChoices = ['last', 'max'];

    const orderDirection = ascendingChoices.includes(config.windowChoice) ? 'ASC' :
                          descendingChoices.includes(config.windowChoice) ? 'DESC' : 'ASC';

    const nullsSuffix = orderDirection === 'ASC' ? ' NULLS FIRST' : ' NULLS LAST';

    return ` ORDER BY ${columnAlias} ${orderDirection}${nullsSuffix}`;
  },

  /**
   * 获取半累加指标使用的非可加时间维度列
   *
   * @param {BaseMeasure} measure
   * @param {NonAdditiveDimensionConfig} config
   * @param {string[]} timeDimensionsForOrdering - 用于 ORDER BY 的时间维度名称列表
   * @returns {string | null} 时间维度列名（带转义）
   */
  getSemiAdditiveTimeDimensionColumn(measure, config, timeDimensionsForOrdering = []) {
    // 检查是否在时间维度列表中（支持 Set 和 Array）
    const hasDimension = typeof timeDimensionsForOrdering.has === 'function'
      ? timeDimensionsForOrdering.has(config.name)
      : timeDimensionsForOrdering.includes(config.name);

    if (!hasDimension) {
      return null;
    }

    // 使用 CTE 中的列别名（格式：_dimensionAlias_for_ordering）
    const cubeName = measure.cube().name;
    const dimensionPath = config.name.includes('.') ? config.name : `${cubeName}.${config.name}`;
    const dimension = this.newDimension(dimensionPath);
    const unescapedAlias = dimension.unescapedAliasName();
    const columnAlias = this.escapeColumnName(`_${unescapedAlias}_for_ordering`);

    return columnAlias;
  },

  /**
   * 获取半累加指标使用的时间维度别名（不带转义）
   * 用于 BaseMeasure 生成 SQL
   *
   * @param {NonAdditiveDimensionConfig} config
   * @returns {string | null} 维度别名
   */
  getSemiAdditiveTimeDimensionAlias(config) {
    // 从当前查询的 dimensions 中查找匹配的维度
    // 首先尝试解析 config.name 获取 cube 名称
    let cubeName;
    let dimensionName;

    if (config.name.includes('.')) {
      const parts = config.name.split('.');
      cubeName = parts[0];
      dimensionName = parts.slice(1).join('.');
    } else {
      // 如果没有 cube 前缀，从当前查询的 dimensions 中查找
      const dimensions = this.dimensionsForSelect();
      if (dimensions && dimensions.length > 0) {
        cubeName = dimensions[0].cube().name;
        dimensionName = config.name;
      } else {
        return null;
      }
    }

    const dimensionPath = `${cubeName}.${dimensionName}`;

    try {
      const dimension = this.newDimension(dimensionPath);
      return dimension.unescapedAliasName();
    } catch (e) {
      return null;
    }
  },

};
