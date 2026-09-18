import {
  promoteTimeDimensionDateRangeFromFilters,
  QueryOptionsWithTimeFilters,
} from '../../src/adapter/helpers/promoteTimeDimensionDateRangeFromFilters';

describe('promoteTimeDimensionDateRangeFromFilters', () => {
  it('copies matching inDateRange onto timeDimensions without dateRange', () => {
    const options: QueryOptionsWithTimeFilters = {
      filters: [{
        member: 'cube.stat_dt',
        operator: 'inDateRange',
        values: ['2026-08-17', '2026-09-17'],
      }],
      timeDimensions: [{
        dimension: 'cube.stat_dt',
        granularity: 'day',
      }],
    };

    const next = promoteTimeDimensionDateRangeFromFilters(options);
    expect(next).not.toBe(options);
    expect(next.timeDimensions![0].dateRange).toEqual(['2026-08-17', '2026-09-17']);
    expect(options.timeDimensions![0].dateRange).toBeUndefined();
  });

  it('does not overwrite an existing timeDimensions.dateRange', () => {
    const options: QueryOptionsWithTimeFilters = {
      filters: [{
        member: 'cube.stat_dt',
        operator: 'inDateRange',
        values: ['2026-01-01', '2026-01-31'],
      }],
      timeDimensions: [{
        dimension: 'cube.stat_dt',
        granularity: 'day',
        dateRange: ['2026-08-17', '2026-09-17'],
      }],
    };

    const next = promoteTimeDimensionDateRangeFromFilters(options);
    expect(next).toBe(options);
    expect(next.timeDimensions![0].dateRange).toEqual(['2026-08-17', '2026-09-17']);
  });

  it('walks nested AND/OR filter trees', () => {
    const options: QueryOptionsWithTimeFilters = {
      filters: [{
        and: [{
          or: [{
            member: 'cube.stat_dt',
            operator: 'inDateRange',
            values: ['2026-08-17', '2026-09-17'],
          }],
        }],
      }],
      timeDimensions: [{
        dimension: 'cube.stat_dt',
        granularity: 'month',
      }],
    };

    const next = promoteTimeDimensionDateRangeFromFilters(options);
    expect(next.timeDimensions![0].dateRange).toEqual(['2026-08-17', '2026-09-17']);
  });

  it('returns the same object when there is nothing to promote', () => {
    const options: QueryOptionsWithTimeFilters = {
      filters: [{ member: 'cube.city', operator: 'equals', values: ['A'] }],
      timeDimensions: [{ dimension: 'cube.stat_dt', granularity: 'day' }],
    };
    expect(promoteTimeDimensionDateRangeFromFilters(options)).toBe(options);
  });
});
