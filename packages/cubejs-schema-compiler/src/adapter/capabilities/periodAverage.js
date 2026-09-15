/**
 * Period average (日均/月均等) query capability.
 *
 * Installed onto BaseQuery.prototype via installQueryCapabilities — dialect
 * overrides (Mysql/Oracle/Dm/Postgres periodAverage* hooks) keep working.
 *
 * Cross-cutting PA × semi-additive helpers live in periodAverageSemiAdditive.js.
 */
import { UserError } from '../../compiler/UserError';
import { BaseTimeDimension } from '../BaseTimeDimension';

export const PeriodAverageCapability = {
  /**
   * 判断 measure filter 中是否存在引用 period_average（含窗口函数）指标的过滤。
   *
   * period_average 指标的 measureSql 含 `SUM(...) OVER (...)` 窗口函数，MySQL/Postgres/
   * 达梦/Oracle 均不允许在 HAVING 中使用窗口函数（MySQL 报 ERROR 3593:
   * "You cannot use the window function 'sum' in this context."）。
   * 此类 filter 必须改走外层子查询 WHERE（见 wrapWithOuterMeasureFilters）。
   *
   * @returns {boolean}
   */
  hasPeriodAverageMeasureFilters() {
    if (!this.measureFilters || !this.measureFilters.length) {
      return false;
    }
    return this.measureFilters.some((f) => {
      const measure = this.findMeasureForFilter(f);
      return !!(measure && typeof measure.isPeriodAverage === 'function' && measure.isPeriodAverage());
    });
  },

  /**
   * 内层 GROUP BY 查询投影的列别名集合（dimensions + measures），
   * 用于外层子查询 SELECT 引用。
   * @returns {string[]}
   */
  periodAverageOuterSelectAliases() {
    const dimensionAliases = this.dimensionAliasNames();
    const measureAliases = this.measures
      .filter((m) => m && typeof m.aliasName === 'function')
      .map((m) => m.aliasName());
    return dimensionAliases.concat(measureAliases);
  },

  /**
   * period_average + denominator:data 是否应走「先按 avg_unit 预聚合」路径。
   * 仅支持无 multiplied/cumulative/multi-stage/semi-additive 的简单查询。
   */
  shouldUsePeriodAverageDataPreAggregatePath(measures = this.measures) {
    if (this.ungrouped || this.multiStageQuery) {
      return false;
    }
    if (this.hasSemiAdditiveMeasures(measures) || this.queryReferencesSemiAdditiveMeasures()) {
      return false;
    }

    const paMeasures = this.collectPeriodAverageDataPreAggregateMeasures(measures);
    if (!paMeasures.length) {
      return false;
    }

    // 仅当查询中所有 measure 都是可预聚合的 data period_average 时才走 CTE 路径；
    // 与 calendar period_average 或其它 measure 混查时外层仍需访问明细表。
    if (paMeasures.length !== measures.length) {
      return false;
    }

    const {
      multipliedMeasures,
      cumulativeMeasures,
      multiStageMembers,
    } = this.fullKeyQueryAggregateMeasures();

    return !multipliedMeasures.length
      && !cumulativeMeasures.length
      && !multiStageMembers.length;
  },

  collectPeriodAverageDataPreAggregateMeasures(measures = this.measures) {
    return measures.filter((measure) => {
      const periodAverage = measure.measureDefinition()?.periodAverage;
      if (!periodAverage || periodAverage.denominator !== 'data') {
        return false;
      }
      const schemaTimeDimension = periodAverage.timeDimension;
      const td = this.periodAverageMatchingTimeDimension(schemaTimeDimension);
      const viewMode = this.periodAverageViewMode(
        periodAverage.avgUnit,
        periodAverage.interval,
        td?.granularity,
      );
      return viewMode === 'interval_bucket' || viewMode === 'range' || viewMode === 'cumulative';
    });
  },

  periodAverageDataPreAggregateUnitColumnAlias(measure) {
    return this.escapeColumnName(`__pa_unit_${measure.unescapedAliasName()}`);
  },

  periodAverageDataPreAggregateSumColumnAlias(measure) {
    return this.escapeColumnName(`__pa_sum_${measure.unescapedAliasName()}`);
  },

  periodAverageDataPreAggregateInnerBaseSql(measure) {
    const periodAverage = measure.measureDefinition().periodAverage;
    const baseMeasure = this.newMeasure(periodAverage.baseMeasure);
    const cubeName = baseMeasure.cube().name;
    const symbol = baseMeasure.measureDefinition();
    const sql = symbol.sql && this.evaluateSql(cubeName, symbol.sql);
    return this.applyMeasureFilters(
      this.autoPrefixWithCubeName(cubeName, sql, false),
      symbol,
      cubeName,
    );
  },

  periodAverageDataPreAggregateUnitBucketSql(measure) {
    const periodAverage = measure.measureDefinition().periodAverage;
    const schemaTimeDimension = periodAverage.timeDimension;
    const tdSql = this.periodAverageTimeDimensionSql(schemaTimeDimension);
    return this.periodAverageToDateExpr(this.timeGroupedColumn(periodAverage.avgUnit, tdSql));
  },

  periodAverageDataPreAggregateOuterMeasureSql(measure, options = {}) {
    const sumCol = this.periodAverageDataPreAggregateSumColumnAlias(measure);
    const unitCol = this.periodAverageDataPreAggregateUnitColumnAlias(measure);
    const periodAverage = measure.measureDefinition().periodAverage;
    const baseMeasure = this.newMeasure(periodAverage.baseMeasure);
    const aggType = (periodAverage.baseAggType || baseMeasure.measureDefinition().type || 'sum').toUpperCase();
    const innerAgg = aggType === 'SUM' || aggType === 'COUNT'
      ? `SUM(${sumCol})`
      : `${aggType}(${sumCol})`;

    // cumulative（区间内累计，含中间粒度）：分子与分母均为「分组聚合 + 窗口累计」。
    // 外层 GROUP BY query 桶后，innerAgg（如 SUM(sumCol)）= 当前桶内聚合值、
    // COUNT(unitCol) = 当前桶内有数据 avgUnit 数；再套 SUM(...) OVER(...) 窗口即在
    // interval 分区内从起点累计到当前桶。此为标准 SQL「窗口套分组聚合」语法。
    if (options.viewMode === 'cumulative' && options.queryBucketSql && options.intervalBucketSql) {
      const partitionBy = this.periodAverageGroupedBucketExpr(options.intervalBucketSql);
      const orderBy = this.periodAverageGroupedBucketExpr(options.queryBucketSql);
      const frame = `PARTITION BY ${partitionBy} ORDER BY ${orderBy} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`;
      const numerator = `SUM(${innerAgg}) OVER (${frame})`;
      const divisor = `SUM(COUNT(${unitCol})) OVER (${frame})`;
      return `(${numerator}) / NULLIF(${divisor}, 0)`;
    }

    return `(${innerAgg}) / NULLIF(COUNT(${unitCol}), 0)`;
  },

  buildPeriodAverageDataQuery() {
    const paMeasures = this.collectPeriodAverageDataPreAggregateMeasures();
    const primaryPaMeasure = paMeasures[0];
    const primaryPeriodAverage = primaryPaMeasure.measureDefinition().periodAverage;
    const schemaTimeDimension = primaryPeriodAverage.timeDimension;
    const inlineWhereConditions = [];
    const subQueryDimensions = this.collectFrom(
      this.dimensionsForSelect()
        .concat(paMeasures)
        .concat(this.allFilters),
      this.collectSubQueryDimensionsFor.bind(this),
      'collectSubQueryDimensionsFor',
    );
    const baseFromSql = this.rewriteInlineWhere(
      () => this.joinQuery(this.join, subQueryDimensions),
      inlineWhereConditions,
    );
    const whereClause = this.baseWhere(this.allFilters.concat(inlineWhereConditions));

    const innerSelectParts = [];
    const innerGroupByParts = [];
    const pushedInnerGroupKeys = new Set();

    const pushInnerGroupExpr = (expr) => {
      const key = String(expr).trim();
      if (pushedInnerGroupKeys.has(key)) {
        return;
      }
      pushedInnerGroupKeys.add(key);
      innerGroupByParts.push(expr);
    };

    this.dimensionsForSelect().forEach((dimension) => {
      if (dimension instanceof BaseTimeDimension) {
        // PA 时间维（schemaTimeDimension）在内层被替换为 avgUnit 桶（见下方 paMeasures 循环），跳过。
        // 非 PA 时间维（如查询用了与 PA 不同的时间列分组）需在内层保留 granularity 桶列，供外层引用。
        if (this.periodAverageTimeDimensionMemberMatches(schemaTimeDimension, dimension.dimension)) {
          return;
        }
        // 无 granularity 的时间维（仅 dateRange filter）无需在内层选取
        if (!dimension.granularity) {
          return;
        }
      }
      const cols = dimension.selectColumns && dimension.selectColumns();
      if (cols) {
        cols.forEach((col) => innerSelectParts.push(col));
      }
      pushInnerGroupExpr(dimension.dimensionSql());
    });

    paMeasures.forEach((measure) => {
      const unitBucket = this.periodAverageDataPreAggregateUnitBucketSql(measure);
      const unitCol = this.periodAverageDataPreAggregateUnitColumnAlias(measure);
      innerSelectParts.push(`${unitBucket} AS ${unitCol}`);
      pushInnerGroupExpr(unitBucket);

      const baseSql = this.periodAverageDataPreAggregateInnerBaseSql(measure);
      const sumCol = this.periodAverageDataPreAggregateSumColumnAlias(measure);
      innerSelectParts.push(`SUM(${baseSql}) AS ${sumCol}`);
    });

    const innerQuery = `SELECT ${innerSelectParts.join(', ')} FROM ${baseFromSql}${whereClause}`
      + (innerGroupByParts.length ? ` GROUP BY ${innerGroupByParts.join(', ')}` : '');

    const outerSelectParts = [];
    const outerGroupByParts = [];
    const pushedOuterGroupKeys = new Set();

    const pushOuterGroupExpr = (expr, selectExpr = expr) => {
      const key = String(expr).trim();
      if (pushedOuterGroupKeys.has(key)) {
        return;
      }
      pushedOuterGroupKeys.add(key);
      outerGroupByParts.push(expr);
      if (selectExpr) {
        outerSelectParts.push(`${selectExpr}`);
      }
    };

    this.dimensionsForSelect().forEach((dimension) => {
      if (dimension instanceof BaseTimeDimension) {
        return;
      }
      // aliasName() 已对标识符做 escapeColumnName 转义（见 BaseDimension.aliasName），
      // 此处不可再包一次 escapeColumnName，否则会产生 ""alias"" 双重引号，
      // 触发 PG「长度为 0 的分隔标示符」错误。与下方时间维度/measure 写法保持一致。
      const alias = dimension.aliasName();
      pushOuterGroupExpr(
        alias,
        `${alias} AS ${alias}`,
      );
    });

    const primaryUnitCol = this.periodAverageDataPreAggregateUnitColumnAlias(primaryPaMeasure);
    // PA 时间维在「外层 query 粒度」上的桶表达式（基于内层 avgUnit 桶列推导），
    // cumulative 模式下作为窗口 ORDER BY 列。仅 PA 时间维带 granularity 时有值。
    let paQueryBucketSql = null;
    let paQueryGranularity = null;

    (this.timeDimensions || []).forEach((td) => {
      if (!this.periodAverageTimeDimensionMemberMatches(schemaTimeDimension, td.dimension)) {
        // 非 PA 时间维：内层 CTE 已按其 granularity 桶选取（别名同 aliasName()），
        // 外层直接引用该别名做 GROUP BY/SELECT（不可用 dimensionSql()，因 FROM 是 CTE 而非原表）。
        if (td.granularity) {
          const tdInstance = this.newTimeDimension(td);
          const alias = tdInstance.aliasName();
          pushOuterGroupExpr(alias, `${alias} AS ${alias}`);
        }
        return;
      }

      if (td.granularity) {
        const tdInstance = this.newTimeDimension(td);
        const outerBucket = this.timeGroupedColumn(td.granularity, primaryUnitCol);
        paQueryBucketSql = outerBucket;
        paQueryGranularity = td.granularity;
        pushOuterGroupExpr(
          outerBucket,
          `${outerBucket} AS ${tdInstance.aliasName()}`,
        );
      }
    });

    this.measures.forEach((measure) => {
      const periodAverage = measure.measureDefinition()?.periodAverage;
      if (
        periodAverage
        && periodAverage.denominator === 'data'
        && this.collectPeriodAverageDataPreAggregateMeasures([measure]).length
      ) {
        const avgUnit = periodAverage.avgUnit || periodAverage.avg_unit || periodAverage.unit;
        const viewMode = this.periodAverageViewMode(
          avgUnit, periodAverage.interval, paQueryGranularity,
        );
        // cumulative：从 query 桶推导 interval 桶，作为窗口 PARTITION BY 列。
        const intervalBucketSql = paQueryBucketSql && viewMode === 'cumulative'
          ? this.periodAverageIntervalBucketFromAvgUnit(paQueryBucketSql, periodAverage.interval)
          : null;
        outerSelectParts.push(
          `${this.periodAverageDataPreAggregateOuterMeasureSql(measure, {
            viewMode,
            queryBucketSql: paQueryBucketSql,
            intervalBucketSql,
          })} AS ${measure.aliasName()}`,
        );
        return;
      }
      const cols = measure.selectColumns && measure.selectColumns();
      if (cols) {
        cols.forEach((col) => outerSelectParts.push(col));
      }
    });

    let query = `WITH period_avg_data_daily AS (${innerQuery}) SELECT ${outerSelectParts.join(', ')}`
      + ` FROM period_avg_data_daily`;

    if (outerGroupByParts.length) {
      query += ` GROUP BY ${outerGroupByParts.join(', ')}`;
    }

    // period_average（窗口函数）指标的 measure filter 不能进 HAVING
    // （MySQL ERROR 3593 等），改走外层子查询 WHERE。
    if (this.hasPeriodAverageMeasureFilters()) {
      const wrapped = this.wrapWithOuterMeasureFilters(query);
      return wrapped + this.orderBy() + this.groupByDimensionLimit();
    }
    query = this.baseHaving(query, this.measureFilters);
    return query + this.orderBy() + this.groupByDimensionLimit();
  },

  /**
   * @param {string} unit
   * @param {string} denominator
   * @param {string} timeDimension
   * @param {string|null|undefined} bucketSql
   * @param {boolean} identity
   * @return {string}
   */
  periodAverageQueryTimeDimension(schemaTimeDimension) {
    return (this.timeDimensions || []).find((td) =>
      this.periodAverageTimeDimensionMemberMatches(schemaTimeDimension, td.dimension)
    ) || null;
  },

  /**
   * SQL for the query time bucket (must match GROUP BY) when computing calendar divisors.
   * Falls back to timeGroupedColumn on the raw dimension only when the query time dimension
   * is unavailable (e.g. unit tests calling periodAverageDivisor directly).
   */
  periodAverageBucketColumnSql(timeDimension, bucketSql, granularity) {
    if (bucketSql) {
      return bucketSql;
    }
    const queryTimeDim = this.periodAverageQueryTimeDimension(timeDimension);
    if (queryTimeDim && granularity) {
      return queryTimeDim.dimensionSql();
    }
    if (granularity) {
      return this.timeGroupedColumn(granularity, this.periodAverageTimeDimensionSql(timeDimension));
    }
    return null;
  },

  periodAverageDivisor(avgUnit, interval, denominator, timeDimension, bucketSql, identity, dataPreAggregated = false, dataBucketSql = null) {
    if (identity) {
      return '1';
    }

    const tdSql = this.periodAverageTimeDimensionSql(timeDimension);
    const td = this.periodAverageMatchingTimeDimension(timeDimension);
    const queryGranularity = td?.granularity;
    this.periodAverageValidateQueryGranularity(avgUnit, interval, queryGranularity, timeDimension);

    const viewMode = this.periodAverageViewMode(avgUnit, interval, queryGranularity);

    if (viewMode === 'range') {
      if (denominator === 'data') {
        const truncated = this.timeGroupedColumn(avgUnit, tdSql);
        return `COUNT(DISTINCT ${this.periodAverageToDateExpr(truncated)})`;
      }
      const range = this.periodAverageDateRange(timeDimension);
      return this.periodAverageCalendarUnitCount(avgUnit, range.start, range.end);
    }

    const bucketColumn = this.periodAverageBucketColumnSql(timeDimension, bucketSql, queryGranularity);
    if (!bucketColumn) {
      throw new UserError(
        `period_average requires either time dimension granularity or a date range filter on '${timeDimension}'`
      );
    }

    if (viewMode === 'cumulative') {
      if (denominator === 'data') {
        // data + cumulative 走 data 预聚合 CTE 路径（shouldUsePeriodAverageDataPreAggregatePath），
        // 分子/分母在 CTE 外层以「分组聚合 + 窗口累计」生成（见 buildPeriodAverageDataQuery）。
        // 此处为标准路径（非 CTE，如与半累加/复合指标混查）的兜底：COUNT(*) OVER 数 granularity
        // 桶数 —— 中间粒度下≠有数据 avgUnit 数，属既有限制，建议改用纯 data PA 查询以走 CTE。
        const intervalBucket = this.periodAverageIntervalBucketFromAvgUnit(bucketColumn, interval);
        return this.periodAverageCumulativeDataDivisor(intervalBucket, bucketColumn);
      }
      return this.periodAverageCumulativeCalendarDivisor(avgUnit, interval, bucketColumn, queryGranularity);
    }

    // interval_bucket / range + data：外层已按 avg_unit 预聚合时，分母为普通 COUNT
    if (dataPreAggregated && denominator === 'data' && bucketSql) {
      return `COUNT(${this.periodAverageGroupedBucketExpr(bucketSql)})`;
    }

    // interval_bucket: one row per configured interval
    if (denominator === 'data') {
      const dataSource = dataBucketSql || bucketSql;
      const truncated = dataSource
        ? this.timeGroupedColumn(avgUnit, dataSource)
        : this.timeGroupedColumn(avgUnit, tdSql);
      return `COUNT(DISTINCT ${this.periodAverageToDateExpr(truncated)})`;
    }

    if (avgUnit === interval) {
      return '1';
    }

    return this.periodAverageCalendarBucketDivisor(avgUnit, interval, bucketColumn, queryGranularity);
  },

  periodAverageNumerator(innerAggSql, avgUnit, interval, timeDimension, bucketSql) {
    const td = this.periodAverageMatchingTimeDimension(timeDimension);
    const queryGranularity = td?.granularity;
    this.periodAverageValidateQueryGranularity(avgUnit, interval, queryGranularity, timeDimension);

    const viewMode = this.periodAverageViewMode(avgUnit, interval, queryGranularity);
    if (viewMode !== 'cumulative') {
      return innerAggSql;
    }

    const avgUnitBucket = this.periodAverageBucketColumnSql(timeDimension, bucketSql, queryGranularity);
    const intervalBucket = this.periodAverageIntervalBucketFromAvgUnit(avgUnitBucket, interval);
    const partitionBy = this.periodAverageGroupedBucketExpr(intervalBucket);
    const orderBy = this.periodAverageGroupedBucketExpr(avgUnitBucket);

    return `SUM(${innerAggSql}) OVER (PARTITION BY ${partitionBy} ORDER BY ${orderBy} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
  },

  /**
   * JS planner path: wrap period_average numerator with configured divisor.
   * Tesseract applies the same formula in PeriodAverageMeasureNode.
   *
   * @param {BaseMeasure} measure
   * @param {string} innerAggSql
   * @returns {string}
   */
  wrapPeriodAverageMeasureSql(measure, innerAggSql) {
    const def = measure.measureDefinition();
    const pa = this.measurePeriodAverageDefinition(def);
    if (!pa) {
      return innerAggSql;
    }
    const avgUnit = pa.avgUnit || pa.avg_unit || pa.unit;
    const timeDimension = pa.timeDimension || pa.time_dimension;
    const numerator = this.periodAverageNumerator(innerAggSql, avgUnit, pa.interval, timeDimension, null);
    const divisor = this.periodAverageDivisor(
      avgUnit,
      pa.interval,
      pa.denominator,
      timeDimension,
      null,
      false,
    );
    return `(${numerator}) / NULLIF(${divisor}, 0)`;
  },

  /**
   * 从查询的 avg_unit GROUP BY 列推导其所在的 interval（区间）桶表达式。
   * 用于累计查看（cumulative）的窗口 PARTITION BY —— **不能引用原始时间维度列**，
   * PostgreSQL 要求窗口 PARTITION BY 表达式基于已分组列。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `DATE_TRUNC`，
   *          适配新数据库时需改为该库的区间归一化函数
   *          （如 MySQL `DATE_FORMAT(...,'%Y-%m-01T00:00:00.000')` / Oracle `TRUNC(...,'MM')`）。
   */
  periodAverageIntervalBucketFromAvgUnit(avgUnitBucket, interval) {
    const grouped = this.periodAverageGroupedBucketExpr(avgUnitBucket);
    switch (interval) {
      case 'day':
        return grouped;
      case 'month':
        return `DATE_TRUNC('month', ${grouped})`;
      case 'quarter':
        return `DATE_TRUNC('quarter', ${grouped})`;
      case 'year':
        return `DATE_TRUNC('year', ${grouped})`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  },

  periodAverageGranularityRank(g) {
    const rank = { day: 0, week: 1, month: 2, quarter: 3, year: 4 };
    return rank[g] ?? 99;
  },

  periodAverageViewMode(avgUnit, interval, queryGranularity) {
    if (!queryGranularity) {
      return 'range';
    }
    if (queryGranularity === interval) {
      return 'interval_bucket';
    }
    // queryGranularity ∈ [avgUnit, interval)（含 avgUnit、不含 interval）→ cumulative。
    // 覆盖「中间粒度累计」：如 day/year 按 month/quarter 查、day/month 按 day 查。
    const ra = this.periodAverageGranularityRank(avgUnit);
    const ri = this.periodAverageGranularityRank(interval);
    const rq = this.periodAverageGranularityRank(queryGranularity);
    if (rq >= ra && rq < ri) {
      return 'cumulative';
    }
    return 'interval_bucket';
  },

  periodAverageValidateQueryGranularity(avgUnit, interval, queryGranularity, timeDimension) {
    if (!queryGranularity) {
      return;
    }
    if (['week', 'hour'].includes(queryGranularity)) {
      throw new UserError(`period_average does not support query granularity '${queryGranularity}'`);
    }
    // granularity === interval → interval_bucket；granularity ∈ [avgUnit, interval) → cumulative。
    if (queryGranularity === interval) {
      return;
    }
    const ra = this.periodAverageGranularityRank(avgUnit);
    const ri = this.periodAverageGranularityRank(interval);
    const rq = this.periodAverageGranularityRank(queryGranularity);
    if (rq >= ra && rq < ri) {
      return;
    }
    throw new UserError(
      `period_average on '${timeDimension}' is configured as avg_unit='${avgUnit}' over interval='${interval}'; `
        + `query granularity must be between '${avgUnit}' (inclusive) and '${interval}' (exclusive), got '${queryGranularity}'`
    );
  },

  periodAverageIntervalBucketSql(timeDimension, interval) {
    const tdSql = this.periodAverageTimeDimensionSql(timeDimension);
    const queryTimeDim = this.periodAverageQueryTimeDimension(timeDimension);
    if (queryTimeDim?.granularity === interval) {
      return queryTimeDim.dimensionSql();
    }
    return this.timeGroupedColumn(interval, tdSql);
  },

  /**
   * 从桶列表达式计算所在 interval（区间）的起始日期。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `DATE_TRUNC(...)::date`，
   *          适配新数据库时需改为该库的区间起点函数（如 `DATE_FORMAT(...,'%Y-%m-01')` / `TRUNC(...,'Q')`）。
   */
  periodAverageIntervalStartExpr(interval, bucketColumn) {
    const grouped = this.periodAverageGroupedBucketExpr(bucketColumn);
    switch (interval) {
      case 'day':
        return this.periodAverageToDateExpr(grouped);
      case 'month':
        return `(DATE_TRUNC('month', ${grouped})::date)`;
      case 'quarter':
        return `(DATE_TRUNC('quarter', ${grouped})::date)`;
      case 'year':
        return `(DATE_TRUNC('year', ${grouped})::date)`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  },

  /**
   * cumulative（区间内累计）calendar 分母。
   * `queryGranularity` 为当前查询桶粒度（可能是 avgUnit 本身，也可能是 avgUnit~interval 之间的中间粒度，
   * 如 day/year 按 month 查）。分母 = 从 interval 起点到「当前 query 桶末（闭区间）」的自然 avgUnit 数；
   * 因此 current 取桶末而非桶首 —— 否则中间粒度（如 month 桶）会少算当月天数。
   * 当 queryGranularity === avgUnit（如 day）时，桶末即当日，与历史行为一致。
   */
  periodAverageCumulativeCalendarDivisor(avgUnit, interval, avgUnitBucket, queryGranularity) {
    const grouped = this.periodAverageGroupedBucketExpr(avgUnitBucket);
    const bucketEnd = this.periodAverageBucketEndExpr(queryGranularity || avgUnit, grouped, false);
    const intervalStart = this.periodAverageIntervalStartExpr(interval, grouped);
    const optimized = this.periodAverageCumulativeCalendarUnitCount(
      avgUnit,
      interval,
      intervalStart,
      bucketEnd,
    );
    if (optimized) {
      return optimized;
    }
    return this.periodAverageCalendarUnitCount(avgUnit, intervalStart, bucketEnd);
  },

  periodAverageCumulativeDataDivisor(intervalBucket, avgUnitBucket) {
    const partitionBy = this.periodAverageGroupedBucketExpr(intervalBucket);
    const orderBy = this.periodAverageGroupedBucketExpr(avgUnitBucket);
    return `COUNT(*) OVER (PARTITION BY ${partitionBy} ORDER BY ${orderBy} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
  },

  periodAverageTimeDimensionMemberMatches(schemaTimeDimension, queryMember) {
    if (!schemaTimeDimension || !queryMember) {
      return false;
    }
    if (schemaTimeDimension === queryMember) {
      return true;
    }

    const schemaParts = schemaTimeDimension.split('.');
    const queryParts = queryMember.split('.');
    const schemaDim = schemaParts[schemaParts.length - 1];
    const queryDim = queryParts[queryParts.length - 1];

    if (schemaDim !== queryDim) {
      return false;
    }

    if (schemaParts.length > 1 && queryParts.length > 1) {
      return schemaParts[0] === queryParts[0];
    }

    return true;
  },

  periodAverageQueryTimeDimensionCandidates() {
    const seen = new Set();
    /** @type {{dimension: string, granularity?: string, dateRange?: string[]}[]} */
    const candidates = [];

    const push = (td) => {
      const normalized = this.normalizeTimeDimensionInput(td);
      if (!normalized?.dimension || seen.has(normalized.dimension)) {
        return;
      }
      seen.add(normalized.dimension);
      candidates.push({
        dimension: normalized.dimension,
        granularity: normalized.granularity,
        dateRange: normalized.dateRange,
      });
    };

    (this.options.timeDimensions || []).forEach(push);
    (this.timeDimensions || []).forEach((td) => push({
      dimension: td.dimension,
      granularity: td.granularity,
      dateRange: td.dateRange,
    }));

    return candidates;
  },

  periodAveragePickMatchingTimeDimension(schemaTimeDimension, candidates) {
    const exact = candidates.find((td) => td.dimension === schemaTimeDimension);
    if (exact) {
      return exact;
    }

    const matched = candidates.filter((td) =>
      this.periodAverageTimeDimensionMemberMatches(schemaTimeDimension, td.dimension)
    );

    if (matched.length === 1) {
      return matched[0];
    }

    const withGranularity = matched.filter((td) => !!td.granularity);
    if (withGranularity.length === 1) {
      return withGranularity[0];
    }

    return matched[0];
  },

  periodAverageMatchingTimeDimension(timeDimension) {
    return this.periodAveragePickMatchingTimeDimension(
      timeDimension,
      this.periodAverageQueryTimeDimensionCandidates(),
    );
  },

  periodAverageTimeDimensionSql(timeDimension) {
    const [cubeName, dimName] = timeDimension.split('.');
    const symbol = this.cubeEvaluator.dimensionByPath(timeDimension);
    return this.convertTz(this.evaluateSymbolSql(cubeName, dimName, symbol, 'dimension'));
  },

  periodAverageQueryShape(timeDimension) {
    const td = this.periodAverageMatchingTimeDimension(timeDimension);
    if (td?.granularity) {
      if (['week', 'hour'].includes(td.granularity)) {
        throw new UserError(`period_average does not support query granularity '${td.granularity}' in MVP`);
      }
      return 'bucketed';
    }
    if (this.periodAverageDateRange(timeDimension)) {
      return 'range_only';
    }
    throw new UserError(
      `period_average requires either time dimension granularity or a date range filter on '${timeDimension}'`
    );
  },

  /**
   * 日期字面量。
   * @dialect 必须重写：默认实现为 PostgreSQL 的 `'...'::date`，
   *          适配新数据库时需改为该库的日期字面量写法（如 `DATE('...')` / `DATE '...'`）。
   */
  periodAverageDateLiteral(dateStr) {
    return `'${dateStr}'::date`;
  },

  periodAverageDateRange(timeDimension) {
    const td = this.periodAverageMatchingTimeDimension(timeDimension);
    if (td?.dateRange?.length === 2) {
      return {
        start: this.periodAverageDateLiteral(td.dateRange[0]),
        end: this.periodAverageScopeEndExpr(this.periodAverageDateLiteral(td.dateRange[1])),
      };
    }

    const filterRange = this.periodAverageFilterDateRange(timeDimension);
    if (filterRange) {
      return filterRange;
    }

    return null;
  },

  periodAverageFilterDateRange(timeDimension) {
    const filters = this.options.filters || [];
    for (const filter of filters) {
      const member = filter.member || filter.dimension;
      if (!this.periodAverageTimeDimensionMemberMatches(timeDimension, member)) {
        continue;
      }
      if (filter.operator === 'inDateRange' && filter.values?.length === 2) {
        return {
          start: this.periodAverageDateLiteral(filter.values[0]),
          end: this.periodAverageScopeEndExpr(this.periodAverageDateLiteral(filter.values[1])),
        };
      }
    }
    return null;
  },

  /**
   * 「当前时间」表达式（用于未完结区间的分母上界）。
   * @dialect 必须重写：默认实现为 PostgreSQL 的 `(NOW() AT TIME ZONE tz)::date`，
   *          适配新数据库时需改为该库的「当前日期」写法。
   * @note 默认实现带时区换算；Oracle/DM 用 SYSDATE（DB 服务器时区），有已知偏差风险。
   */
  periodAverageNowExpr() {
    const frozenNow = process.env.CUBEJS_TEST_NOW;
    if (frozenNow) {
      return this.periodAverageDateLiteral(frozenNow);
    }
    return `(NOW() AT TIME ZONE '${this.timezone}')::date`;
  },

  periodAverageScopeEndExpr(endExpr) {
    return endExpr;
  },

  /**
   * 把任意日期/时间表达式强制转为 DATE 类型。
   * @dialect 必须重写：默认实现为 PostgreSQL 的 `(...)::date`，
   *          适配新数据库时需改为该库的类型转换写法（如 `CAST(... AS DATE)` / `DATE(...)`）。
   */
  periodAverageToDateExpr(sql) {
    return `(${sql})::date`;
  },

  /**
   * 两个日期之间的自然日数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的日期相减语法，
   *          适配新数据库时需改为该库的日期差函数（如 `DATEDIFF` / `CAST AS DATE 相减`）。
   */
  daysBetweenInclusive(start, end) {
    return `GREATEST((${end} - ${start} + 1), 0)`;
  },

  periodAverageCalendarUnitCount(unit, start, end) {
    switch (unit) {
      case 'day':
        return this.daysBetweenInclusive(start, end);
      case 'month':
        return this.monthsBetweenInclusive(start, end);
      case 'quarter':
        return this.quartersBetweenInclusive(start, end);
      case 'year':
        return this.yearsBetweenInclusive(start, end);
      default:
        throw new UserError(`Unsupported period_average unit '${unit}'`);
    }
  },

  /**
   * 在窗口函数 / GROUP BY 中使用的桶列表达式。
   * 部分数据库（MySQL/Oracle/DM）要求窗口 PARTITION BY/ORDER BY 里的表达式必须是
   * 已分组列，因此非 ungrouped 时需用 `MIN(...)` 包装。
   * @dialect 必须重写：PostgreSQL 直接返回原列即可；MySQL/Oracle/DM 需 `MIN(...)` 包装。
   */
  periodAverageGroupedBucketExpr(bucketColumn, options = {}) {
    if (options.aggregateOnce && !this.ungrouped) {
      return `MIN(${bucketColumn})`;
    }
    return bucketColumn;
  },

  /**
   * Closed-form calendar unit count inside an interval bucket (interval_bucket view).
   * Uses only the grouped bucket expression — no per-row raw time dimension.
   */
  periodAverageCalendarUnitsInIntervalBucket(avgUnit, interval, groupedBucket, bucketAlreadyAtInterval) {
    if (bucketAlreadyAtInterval) {
      if (avgUnit === interval) {
        return '1';
      }

      const closedForm = this.periodAverageClosedFormIntervalBucketUnits(avgUnit, interval, groupedBucket);
      if (closedForm) {
        return closedForm;
      }
    }

    const bucketStart = bucketAlreadyAtInterval
      ? this.periodAverageToDateExpr(groupedBucket)
      : this.periodAverageIntervalStartExpr(interval, groupedBucket);
    const bucketEnd = this.periodAverageBucketEndExpr(interval, groupedBucket, bucketAlreadyAtInterval);
    return this.periodAverageCalendarUnitCount(avgUnit, bucketStart, bucketEnd);
  },

  /**
   * interval_bucket（整区间）calendar 分母的快路径：返回常数或闭式表达式，避免逐行日期运算。
   * 默认实现仅返回「恒定常数」（如 month/year 的 12、3、4），不处理 day 维度。
   * @dialect 应当重写：先调 super 处理常数情形，再补充 day 口径下
   *          「月/季/年桶内的天数」（如 MySQL `DAY(LAST_DAY(...))` / Oracle `EXTRACT(DAY FROM LAST_DAY)`）。
   *          适配新数据库时务必检查是否需要补充 day 快路径，否则会回退到较慢的日期差通用路径。
   * @returns {string|null}
   */
  periodAverageClosedFormIntervalBucketUnits(avgUnit, interval, groupedBucket) {
    if (avgUnit === 'month') {
      if (interval === 'quarter') {
        return '3';
      }
      if (interval === 'year') {
        return '12';
      }
    }
    if (avgUnit === 'quarter' && interval === 'year') {
      return '4';
    }
    return null;
  },

  /**
   * cumulative（区间内累计）calendar 分母的快路径：从区间起点到当前行的自然 avg_unit 数。
   * 默认实现覆盖 day（日期差）和 month（EXTRACT(MONTH) 差）。
   * @dialect 应当重写：先调 super，再补充该库的日期差写法
   *          （如 MySQL `DATEDIFF` / Oracle `CAST AS DATE 相减`）。
   *          适配新数据库时务必检查 day/month 快路径，否则回退到较慢的通用 *BetweenInclusive 路径。
   * @returns {string|null}
   */
  periodAverageCumulativeCalendarUnitCount(avgUnit, interval, intervalStart, current) {
    if (avgUnit === 'day') {
      return `GREATEST((${current} - ${intervalStart} + 1), 0)`;
    }
    if (avgUnit === 'month' && (interval === 'year' || interval === 'quarter' || interval === 'month')) {
      return `GREATEST((EXTRACT(MONTH FROM ${current})::int - EXTRACT(MONTH FROM ${intervalStart})::int + 1), 0)`;
    }
    return null;
  },

  periodAverageCalendarBucketDivisor(avgUnit, interval, bucketColumn, queryGranularity) {
    const groupedBucket = this.periodAverageGroupedBucketExpr(bucketColumn, { aggregateOnce: true });
    const bucketAlreadyAtInterval = queryGranularity === interval;
    return this.periodAverageCalendarUnitsInIntervalBucket(
      avgUnit,
      interval,
      groupedBucket,
      bucketAlreadyAtInterval,
    );
  },

  /**
   * 从桶列表达式计算所在 interval（区间）的结束日期（含当日，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `DATE_TRUNC + INTERVAL`，
   *          适配新数据库时需改为该库的区间终点函数（如 `LAST_DAY(...)`）。
   */
  periodAverageBucketEndExpr(granularity, bucketColumn, bucketAlreadyAtInterval = false) {
    if (bucketAlreadyAtInterval) {
      switch (granularity) {
        case 'day':
          return this.periodAverageToDateExpr(bucketColumn);
        case 'month':
          return `((${bucketColumn}) + INTERVAL '1 month' - INTERVAL '1 day')::date`;
        case 'quarter':
          return `((${bucketColumn}) + INTERVAL '3 months' - INTERVAL '1 day')::date`;
        case 'year':
          return `((${bucketColumn}) + INTERVAL '1 year' - INTERVAL '1 day')::date`;
        default:
          return this.periodAverageToDateExpr(bucketColumn);
      }
    }

    switch (granularity) {
      case 'day':
        return `${bucketColumn}::date`;
      case 'month':
        return `((DATE_TRUNC('month', ${bucketColumn}) + INTERVAL '1 month' - INTERVAL '1 day')::date)`;
      case 'quarter':
        return `((DATE_TRUNC('quarter', ${bucketColumn}) + INTERVAL '3 months' - INTERVAL '1 day')::date)`;
      case 'year':
        return `((DATE_TRUNC('year', ${bucketColumn}) + INTERVAL '1 year' - INTERVAL '1 day')::date)`;
      default:
        return `${bucketColumn}::date`;
    }
  },

  /**
   * 两个日期之间的自然月数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `EXTRACT/AGE`，
   *          适配新数据库时需改为该库的月份差函数（如 `TIMESTAMPDIFF(MONTH,...)` / `MONTHS_BETWEEN`）。
   */
  monthsBetweenInclusive(start, end) {
    return `GREATEST((EXTRACT(YEAR FROM AGE(${end}, ${start}))::int * 12 + EXTRACT(MONTH FROM AGE(${end}, ${start}))::int + 1), 0)`;
  },

  /**
   * 两个日期之间的自然季度数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `EXTRACT/AGE`，
   *          适配新数据库时需改为该库的季度差函数（如 `TIMESTAMPDIFF(QUARTER,...)` / `MONTHS_BETWEEN/3`）。
   */
  quartersBetweenInclusive(start, end) {
    return `GREATEST((EXTRACT(YEAR FROM AGE(${end}, ${start}))::int * 4 + FLOOR(EXTRACT(MONTH FROM AGE(${end}, ${start}))::int / 3) + 1), 0)`;
  },

  /**
   * 两个日期之间的自然年数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `EXTRACT/AGE`，
   *          适配新数据库时需改为该库的年份差函数（如 `TIMESTAMPDIFF(YEAR,...)` / `MONTHS_BETWEEN/12`）。
   */
  yearsBetweenInclusive(start, end) {
    return `GREATEST((EXTRACT(YEAR FROM AGE(${end}, ${start}))::int + 1), 0)`;
  },

  measurePeriodAverageDefinition(measureDefinition) {
    if (!measureDefinition) {
      return null;
    }
    const meta = measureDefinition.meta;
    return measureDefinition.periodAverage
      || measureDefinition.period_average
      || (meta && typeof meta === 'object' && (meta.periodAverage || meta.period_average))
      || null;
  },

  isPeriodAverageMeasureDefinition(measureDefinition) {
    return !!this.measurePeriodAverageDefinition(measureDefinition);
  },

  isPeriodAverageMeasure(measure) {
    if (!measure) {
      return false;
    }
    try {
      if (typeof measure.isPeriodAverage === 'function' && measure.isPeriodAverage()) {
        return true;
      }
    } catch (e) {
      // ignore
    }
    try {
      return this.isPeriodAverageMeasureDefinition(measure.measureDefinition());
    } catch (e) {
      return false;
    }
  },

  queryPeriodAverageMeasures(measures = this.measures) {
    return (measures || []).filter((m) => this.isPeriodAverageMeasure(m));
  },

  periodAverageBaseMeasurePathFromDefinition(measureDefinition) {
    const periodAverage = this.measurePeriodAverageDefinition(measureDefinition);
    if (!periodAverage) {
      return null;
    }
    return periodAverage.baseMeasure || periodAverage.base_measure || null;
  },

  periodAverageBaseMeasurePath(measure) {
    const fromDefinition = this.periodAverageBaseMeasurePathFromDefinition(measure.measureDefinition());
    if (fromDefinition) {
      return fromDefinition;
    }

    const selfPath = measure.expressionPath && measure.expressionPath();

    try {
      const refs = this.collectFrom(
        [measure],
        this.collectMemberNamesFor.bind(this),
        'collectMemberNamesFor',
      );
      const measureRefs = (refs || []).filter((path) => {
        if (!path || path === selfPath || !this.cubeEvaluator.isMeasure(path)) {
          return false;
        }
        try {
          return !this.isPeriodAverageMeasureDefinition(this.newMeasure(path).measureDefinition());
        } catch (e) {
          return true;
        }
      });
      if (measureRefs.length === 1) {
        return measureRefs[0];
      }
    } catch (e) {
      return null;
    }

    return null;
  },

  periodAverageBaseMeasurePathsInQuery(measures = this.measures) {
    const paths = new Set();
    this.queryPeriodAverageMeasures(measures).forEach((measure) => {
      const basePath = this.periodAverageBaseMeasurePath(measure);
      if (basePath) {
        paths.add(basePath);
      }
    });
    return paths;
  },

};
