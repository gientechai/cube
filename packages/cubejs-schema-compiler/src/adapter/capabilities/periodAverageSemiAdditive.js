/**
 * Bridge: period_average × semi-additive (point-in-time) collaboration.
 *
 * Called from semi-additive CTE projection / outer SELECT via `this.*`.
 * Do not import this module from semiAdditive.js — keep deps on the query instance.
 */
import { buildRawMeasureSql } from './measureSqlUtils';

export const PeriodAverageSemiAdditiveCapability = {
  periodAverageSemiAdditiveBaseColumnAlias(measure) {
    return this.escapeColumnName(`__pa_base_${measure.unescapedAliasName()}`);
  },

  /**
   * 半累加 CTE 最终 SELECT 来自 windowed_data，period_average 分母须引用已投影的时间维别名。
   *
   * @param {string} timeDimension
   * @returns {string|null}
   */
  periodAverageSemiAdditiveBucketColumnSql(timeDimension) {
    const td = this.periodAverageMatchingTimeDimension(timeDimension);
    if (!td?.granularity) {
      return null;
    }

    const matchingDimension = this.dimensionsForSelect().find((d) => {
      const dimPath = typeof d.expressionPath === 'function'
        ? d.expressionPath()
        : d.dimension;
      return this.periodAverageTimeDimensionMemberMatches(timeDimension, dimPath);
    });

    if (!matchingDimension) {
      return null;
    }

    return matchingDimension.aliasName();
  },

  /**
   * 半累加 CTE 内用于 data 分母的明细时间列（day 粒度 DISTINCT 计数）。
   * month 桶查询时 interval 桶别名不足以做 day 级 COUNT DISTINCT，须用行级 stat_dt 投影。
   *
   * @param {string} timeDimension
   * @returns {string|null}
   */
  periodAverageSemiAdditiveRowTimeColumnSql(timeDimension) {
    const matchingDimensions = this.dimensionsForSelect().filter((d) => {
      const dimPath = typeof d.expressionPath === 'function'
        ? d.expressionPath()
        : d.dimension;
      return this.periodAverageTimeDimensionMemberMatches(timeDimension, dimPath);
    });

    const withoutGranularity = matchingDimensions.find((d) => !d.granularity);
    if (withoutGranularity) {
      return withoutGranularity.aliasName();
    }

    const granularityRank = { day: 0, week: 1, month: 2, quarter: 3, year: 4 };
    const sorted = matchingDimensions
      .filter((d) => d.granularity)
      .sort((a, b) => (
        (granularityRank[a.granularity] ?? 99) - (granularityRank[b.granularity] ?? 99)
      ));
    if (sorted.length > 0 && sorted[0].granularity === 'day') {
      return sorted[0].aliasName();
    }

    const td = this.periodAverageMatchingTimeDimension(timeDimension);
    if (td?.dimension) {
      return this.aliasName(td.dimension);
    }

    return null;
  },

  periodAverageSemiAdditiveBaseRawSql(measure) {
    const basePath = this.periodAverageBaseMeasurePath(measure);
    if (!basePath) {
      return null;
    }
    const baseMeasure = this.newMeasure(basePath);
    const { sql, rendered } = buildRawMeasureSql(this, baseMeasure);
    if (!sql) {
      return null;
    }
    return rendered;
  },

  renderPeriodAverageSemiAdditiveMeasureSql(measure) {
    const def = measure.measureDefinition();
    const pa = this.measurePeriodAverageDefinition(def);
    if (!pa) {
      return null;
    }
    const avgUnit = pa.avgUnit || pa.avg_unit || pa.unit;
    const timeDimension = pa.timeDimension || pa.time_dimension;
    const baseMeasurePath = this.periodAverageBaseMeasurePath(measure);
    if (!baseMeasurePath) {
      return null;
    }
    const baseMeasure = this.newMeasure(baseMeasurePath);
    const aggType = (pa.baseAggType || pa.base_agg_type || baseMeasure.measureDefinition().type || 'sum').toUpperCase();
    const paCol = this.periodAverageSemiAdditiveBaseColumnAlias(measure);
    const innerAgg = aggType === 'SUM' || aggType === 'COUNT'
      ? `SUM(${paCol})`
      : `${aggType}(${paCol})`;
    const paIntervalBucketSql = this.periodAverageSemiAdditiveBucketColumnSql(timeDimension);
    const paRowTimeSql = this.periodAverageSemiAdditiveRowTimeColumnSql(timeDimension);
    const paDataBucketSql = paRowTimeSql || paIntervalBucketSql;
    const numerator = this.periodAverageNumerator(innerAgg, avgUnit, pa.interval, timeDimension, paIntervalBucketSql);
    const divisor = this.periodAverageDivisor(
      avgUnit,
      pa.interval,
      pa.denominator,
      timeDimension,
      paIntervalBucketSql,
      false,
      false,
      paDataBucketSql,
    );
    return `(${numerator}) / NULLIF(${divisor}, 0) as ${measure.aliasName()}`;
  },

};
