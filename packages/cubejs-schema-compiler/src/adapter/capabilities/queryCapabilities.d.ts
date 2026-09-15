/**
 * Instance methods installed onto BaseQuery.prototype by installQueryCapabilities.
 * Keep in sync with QUERY_CAPABILITIES method tables (names only; signatures are loose).
 */

export {};

declare module '../BaseQuery' {
  interface BaseQuery {
    allocateSemiAdditiveCteNames(...args: any[]): any;
    assembleSemiAdditiveJoinSql(...args: any[]): any;
    assembleSemiAdditiveWindowSql(...args: any[]): any;
    buildPeriodAverageDataQuery(...args: any[]): any;
    buildSemiAdditiveCTEQuery(...args: any[]): any;
    buildSemiAdditiveJoinQuery(...args: any[]): any;
    buildSemiAdditiveMeasuresQuery(...args: any[]): any;
    buildSemiAdditiveOrderBy(...args: any[]): any;
    buildSemiAdditiveOuterSelect(...args: any[]): any;
    buildSemiAdditivePartitionBy(...args: any[]): any;
    buildSemiAdditivePartitionExprs(...args: any[]): any;
    buildSemiAdditiveWindowQuery(...args: any[]): any;
    canUseSemiAdditiveJoinPath(...args: any[]): any;
    collectPeriodAverageDataPreAggregateMeasures(...args: any[]): any;
    collectReferencedSemiAdditiveMeasures(...args: any[]): any;
    collectSemiAdditivePartitionClauses(...args: any[]): any;
    daysBetweenInclusive(...args: any[]): any;
    directSemiAdditiveMeasurePathsInQuery(...args: any[]): any;
    findMeasureForFilter(...args: any[]): any;
    getSemiAdditiveTimeDimensionAlias(...args: any[]): any;
    getSemiAdditiveTimeDimensionColumn(...args: any[]): any;
    hasPeriodAverageMeasureFilters(...args: any[]): any;
    hasSemiAdditiveMeasures(...args: any[]): any;
    isPeriodAverageMeasure(...args: any[]): any;
    isPeriodAverageMeasureDefinition(...args: any[]): any;
    measurePeriodAverageDefinition(...args: any[]): any;
    monthsBetweenInclusive(...args: any[]): any;
    periodAverageBaseMeasurePath(...args: any[]): any;
    periodAverageBaseMeasurePathFromDefinition(...args: any[]): any;
    periodAverageBaseMeasurePathsInQuery(...args: any[]): any;
    periodAverageBucketColumnSql(...args: any[]): any;
    periodAverageBucketEndExpr(...args: any[]): any;
    periodAverageCalendarBucketDivisor(...args: any[]): any;
    periodAverageCalendarUnitCount(...args: any[]): any;
    periodAverageCalendarUnitsInIntervalBucket(...args: any[]): any;
    periodAverageClosedFormIntervalBucketUnits(...args: any[]): any;
    periodAverageCumulativeCalendarDivisor(...args: any[]): any;
    periodAverageCumulativeCalendarUnitCount(...args: any[]): any;
    periodAverageCumulativeDataDivisor(...args: any[]): any;
    periodAverageDataPreAggregateInnerBaseSql(...args: any[]): any;
    periodAverageDataPreAggregateOuterMeasureSql(...args: any[]): any;
    periodAverageDataPreAggregateSumColumnAlias(...args: any[]): any;
    periodAverageDataPreAggregateUnitBucketSql(...args: any[]): any;
    periodAverageDataPreAggregateUnitColumnAlias(...args: any[]): any;
    periodAverageDateLiteral(...args: any[]): any;
    periodAverageDateRange(...args: any[]): any;
    periodAverageDivisor(...args: any[]): any;
    periodAverageFilterDateRange(...args: any[]): any;
    periodAverageGranularityRank(...args: any[]): any;
    periodAverageGroupedBucketExpr(...args: any[]): any;
    periodAverageIntervalBucketFromAvgUnit(...args: any[]): any;
    periodAverageIntervalBucketSql(...args: any[]): any;
    periodAverageIntervalStartExpr(...args: any[]): any;
    periodAverageMatchingTimeDimension(...args: any[]): any;
    periodAverageNowExpr(...args: any[]): any;
    periodAverageNumerator(...args: any[]): any;
    periodAverageOuterSelectAliases(...args: any[]): any;
    periodAveragePickMatchingTimeDimension(...args: any[]): any;
    periodAverageQueryShape(...args: any[]): any;
    periodAverageQueryTimeDimension(...args: any[]): any;
    periodAverageQueryTimeDimensionCandidates(...args: any[]): any;
    periodAverageScopeEndExpr(...args: any[]): any;
    periodAverageSemiAdditiveBaseColumnAlias(...args: any[]): any;
    periodAverageSemiAdditiveBaseRawSql(...args: any[]): any;
    periodAverageSemiAdditiveBucketColumnSql(...args: any[]): any;
    periodAverageSemiAdditiveRowTimeColumnSql(...args: any[]): any;
    periodAverageTimeDimensionMemberMatches(...args: any[]): any;
    periodAverageTimeDimensionSql(...args: any[]): any;
    periodAverageToDateExpr(...args: any[]): any;
    periodAverageValidateQueryGranularity(...args: any[]): any;
    periodAverageViewMode(...args: any[]): any;
    quartersBetweenInclusive(...args: any[]): any;
    queryHasSemiAdditiveMeasures(...args: any[]): any;
    queryPeriodAverageMeasures(...args: any[]): any;
    queryReferencesSemiAdditiveMeasures(...args: any[]): any;
    rawMeasureSql(...args: any[]): any;
    renderPeriodAverageSemiAdditiveMeasureSql(...args: any[]): any;
    rewriteSemiAdditiveOuterMeasureSql(...args: any[]): any;
    semiAdditiveAggregateFilter(...args: any[]): any;
    semiAdditiveBaseColumnAliases(...args: any[]): any;
    semiAdditiveBoundaryAggFunc(...args: any[]): any;
    semiAdditiveDimensionProjectionKey(...args: any[]): any;
    semiAdditiveMeasureRawSql(...args: any[]): any;
    semiAdditiveNullSafeEqual(...args: any[]): any;
    semiAdditiveOrderingColumnSql(...args: any[]): any;
    semiAdditiveOuterSqlReferencesMainCubeAlias(...args: any[]): any;
    semiAdditivePreferSubqueriesOverWith(...args: any[]): any;
    semiAdditiveWindowFunction(...args: any[]): any;
    shouldUsePeriodAverageDataPreAggregatePath(...args: any[]): any;
    shouldUseRenderedReferenceForMeasurePath(...args: any[]): any;
    shouldUseSemiAdditiveAggregation(...args: any[]): any;
    shouldUseSemiAdditiveAggregationForMeasurePath(...args: any[]): any;
    supportsFilterClause(...args: any[]): any;
    wrapPeriodAverageMeasureSql(...args: any[]): any;
    wrapWithOuterMeasureFilters(...args: any[]): any;
    yearsBetweenInclusive(...args: any[]): any;
  }
}
