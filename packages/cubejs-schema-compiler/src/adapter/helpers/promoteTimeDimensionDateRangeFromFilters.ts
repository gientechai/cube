/**
 * 将同维度的 filters.inDateRange 写入缺少 dateRange 的 timeDimensions。
 * 不删除原 filter，也不覆盖已有 dateRange。
 *
 * 修正前（timeDimensions 无 dateRange）：
 * {
 *   timeDimensions: [{ dimension: 'loan.data_date', granularity: 'day' }],
 *   filters: [{
 *     member: 'loan.data_date',
 *     operator: 'inDateRange',
 *     values: ['2026-08-18', '2026-09-18']
 *   }]
 * }
 *
 * 修正后：
 * {
 *   timeDimensions: [{
 *     dimension: 'loan.data_date',
 *     granularity: 'day',
 *     dateRange: ['2026-08-18', '2026-09-18']
 *   }],
 *   filters: [{
 *     member: 'loan.data_date',
 *     operator: 'inDateRange',
 *     values: ['2026-08-18', '2026-09-18']
 *   }]
 * }
 */

export type QueryFilter = {
  member?: string;
  dimension?: string;
  operator?: string;
  values?: string[];
  and?: QueryFilter[];
  or?: QueryFilter[];
};

export type QueryTimeDimension = {
  dimension: string;
  granularity?: string;
  dateRange?: string | [string, string];
};

export type QueryOptionsWithTimeFilters = {
  filters?: QueryFilter[];
  timeDimensions?: QueryTimeDimension[];
  [key: string]: unknown;
};

function walkFilters(filters: QueryFilter[], visit: (filter: QueryFilter) => void): void {
  for (const filter of filters) {
    if (filter.and?.length) {
      walkFilters(filter.and, visit);
    } else if (filter.or?.length) {
      walkFilters(filter.or, visit);
    } else {
      visit(filter);
    }
  }
}

/** First inDateRange per dimension (AND/OR tree flattened; duplicates ignored). */
function collectInDateRangeByDimension(
  filters: QueryFilter[],
): Map<string, [string, string]> {
  const byDimension = new Map<string, [string, string]>();

  walkFilters(filters, (filter) => {
    const dimension = filter.member || filter.dimension;
    if (
      filter.operator !== 'inDateRange'
      || !dimension
      || byDimension.has(dimension)
      || !Array.isArray(filter.values)
      || filter.values.length !== 2
    ) {
      return;
    }
    byDimension.set(dimension, [filter.values[0], filter.values[1]]);
  });

  return byDimension;
}

/**
 * @returns Same options reference when nothing changes; otherwise a shallow copy
 * with updated timeDimensions.
 */
export function promoteTimeDimensionDateRangeFromFilters<T extends QueryOptionsWithTimeFilters>(
  options: T,
): T {
  const timeDimensions = options?.timeDimensions;
  const filters = options?.filters;
  if (!timeDimensions?.length || !filters?.length) {
    return options;
  }

  const rangesByDimension = collectInDateRangeByDimension(filters);
  if (!rangesByDimension.size) {
    return options;
  }

  let changed = false;
  const nextTimeDimensions = timeDimensions.map((timeDimension) => {
    if (timeDimension.dateRange) {
      return timeDimension;
    }
    const dateRange = rangesByDimension.get(timeDimension.dimension);
    if (!dateRange) {
      return timeDimension;
    }
    changed = true;
    return { ...timeDimension, dateRange };
  });

  return changed ? { ...options, timeDimensions: nextTimeDimensions } : options;
}
