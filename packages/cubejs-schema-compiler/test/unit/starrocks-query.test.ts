/* eslint-disable no-restricted-syntax */
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { StarRocksQuery } from '../../src/adapter/StarRocksQuery';
import { createQuery } from '../../src/adapter/QueryBuilder';
import { prepareJsCompiler } from './PrepareCompiler';

describe('StarRocksQuery', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(
    `
    cube(\`visitors\`, {
      sql: \`select * from visitors\`,
      measures: {
        count: {
          type: 'count'
        }
      },
      dimensions: {
        createdAt: {
          type: 'time',
          sql: 'created_at'
        }
      }
    })
    `,
    { adapter: 'starrocks' }
  );

  const compilers = () => ({ joinGraph, cubeEvaluator, compiler });

  it('is registered for dbType starrocks via createQuery', async () => {
    await compiler.compile();
    const query = createQuery(compilers(), 'starrocks', {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    expect(query).toBeInstanceOf(StarRocksQuery);
    expect(query).toBeInstanceOf(MysqlQuery);
  });

  it('sqlTemplates: generated time series uses generate_series, not WITH RECURSIVE', async () => {
    await compiler.compile();
    const query = new StarRocksQuery(compilers(), {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    const templates = query.sqlTemplates();
    const selectTemplate = templates.statements.generated_time_series_select;
    const withCteTemplate = templates.statements.generated_time_series_with_cte_range_source;

    expect(selectTemplate).toContain('TABLE(generate_series');
    expect(selectTemplate).toContain('gen.generate_series');
    expect(selectTemplate.match(/\| lower/g)).toHaveLength(3);
    expect(selectTemplate).not.toContain('WITH RECURSIVE');
    expect(selectTemplate).not.toContain('CONNECT BY');
    expect(selectTemplate).not.toContain('NUMTODSINTERVAL');
    expect(selectTemplate).not.toContain('ADD_MONTHS');
    expect(selectTemplate).not.toContain('MONTHS_BETWEEN');

    // Jinja granularity branches (DmQuery parity)
    expect(selectTemplate).toContain('g == \'1 second\'');
    expect(selectTemplate).toContain('g == \'1 minute\'');
    expect(selectTemplate).toContain('g == \'1 hour\'');
    expect(selectTemplate).toContain('g == \'1 day\'');
    expect(selectTemplate).toContain('g == \'1 week\'');
    expect(selectTemplate).toContain('g == \'1 month\'');
    expect(selectTemplate).toContain('g == \'3 month\'');
    expect(selectTemplate).toContain('g == \'1 quarter\'');
    expect(selectTemplate).toContain('g == \'1 year\'');

    // else-day fallback for unknown granularities
    expect(selectTemplate).toContain('{% else %}DATE_ADD');
    expect(selectTemplate).toMatch(/INTERVAL\s*\([^)]+\)\s*DAY/);

    // date_to uses next-bucket start minus 1 second
    expect(selectTemplate).toContain('DATE_SUB(');
    expect(selectTemplate).toContain('INTERVAL 1 SECOND)');

    expect(query.intervalString('1 month')).toBe('1 MONTH');
    expect(query.intervalString('1 month').toLowerCase()).toBe('1 month');

    expect(withCteTemplate).toContain(', generate_series(');
    expect(withCteTemplate).toContain('generate_series(CAST(1 AS BIGINT)');
    expect(withCteTemplate).not.toContain('CROSS JOIN TABLE(generate_series');
    expect(withCteTemplate).toContain('gen.generate_series');
    expect(withCteTemplate.match(/\| lower/g)).toHaveLength(3);
    expect(withCteTemplate).toContain('{{ range_source }}');
    expect(withCteTemplate).toContain('bounds');
    expect(withCteTemplate).not.toContain('WITH RECURSIVE');
    expect(withCteTemplate).not.toContain('CONNECT BY');
    expect(withCteTemplate).not.toContain('NUMTODSINTERVAL');
    expect(withCteTemplate).not.toContain('ADD_MONTHS');
    expect(withCteTemplate).not.toContain('MONTHS_BETWEEN');
  });

  it('inherits MySQL identifier quotes and disables FULL JOIN', async () => {
    await compiler.compile();
    const query = new StarRocksQuery(compilers(), {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    const templates = query.sqlTemplates();
    expect(templates.quotes.identifiers).toBe('`');
    expect(templates.join_types.full).toBeUndefined();
  });

  it('supportGeneratedSeriesForCustomTd is true', async () => {
    await compiler.compile();
    const query = new StarRocksQuery(compilers(), {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    expect(query.supportGeneratedSeriesForCustomTd()).toBe(true);
  });

  it('uses date_trunc for timeGroupedColumn and space-separated timestampFormat', async () => {
    await compiler.compile();
    const query = new StarRocksQuery(compilers(), {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    expect(query.timestampFormat()).toBe('YYYY-MM-DD HH:mm:ss.SSS');
    expect(query.timeGroupedColumn('day', 'stat_dt')).toBe('date_trunc(\'day\', stat_dt)');
    expect(query.timeGroupedColumn('month', 'stat_dt')).toBe('date_trunc(\'month\', stat_dt)');
    expect(query.timeGroupedColumn('year', 'stat_dt')).toBe('date_trunc(\'year\', stat_dt)');
    expect(query.dateTimeCast('?')).toBe('CAST(? AS DATETIME)');
  });
});
