/* eslint-disable no-restricted-syntax */
import { DmQuery } from '../../src/adapter/DmQuery';
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareJsCompiler } from './PrepareCompiler';

describe('semi-additive measure schema filters', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`score1\`, {
      sql: \`SELECT * FROM xss.student_scores\`,

      dimensions: {
        examDate: {
          sql: \`\${CUBE}.exam_date\`,
          type: 'time',
        },
        subject: {
          sql: \`\${CUBE}.subject\`,
          type: 'string',
        },
      },

      measures: {
        meChineseScoreEnd: {
          sql: \`\${CUBE}.score\`,
          type: 'sum',
          filters: [{
            sql: \`\${CUBE}.subject = '语文'\`,
          }],
          nonAdditiveDimension: {
            name: 'examDate',
            windowChoice: 'max',
          },
        },
      },
    })
  `);

  it('applies schema filters to semi-additive raw column only', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.meChineseScoreEnd'],
        timeDimensions: [{
          dimension: 'score1.examDate',
          granularity: 'year',
        }],
        timezone: 'Pacific/Midway',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/CASE WHEN .*subject.*=.*'语文'.*THEN.*score/i);
    // 窗口 MAX 仍对所有行取最晚日期，不按 filter 收窄
    expect(sql).toMatch(/MAX\("_score1__exam_date_for_ordering"\) OVER/i);
    expect(sql).not.toMatch(/MAX\(CASE WHEN.*_raw IS NOT NULL/i);
  });
});

describe('semi-additive calculated measure references', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`score1\`, {
      sql: \`SELECT * FROM xss.student_scores\`,

      dimensions: {
        examDate: {
          sql: \`\${CUBE}.exam_date\`,
          type: 'time',
        },
        subject: {
          sql: \`\${CUBE}.subject\`,
          type: 'string',
        },
      },

      measures: {
        sdggg: {
          sql: \`\${CUBE}.score\`,
          type: 'sum',
          nonAdditiveDimension: {
            name: 'examDate',
            windowChoice: 'max',
          },
        },
        qcjs: {
          sql: \`\${CUBE}.score\`,
          type: 'count_distinct',
          nonAdditiveDimension: {
            name: 'examDate',
            windowChoice: 'min',
          },
        },
        fuhezhibiao: {
          type: 'number',
          sql: \`\${sdggg} / \${qcjs}\`,
        },
      },
    })
  `);

  it('uses semi-additive CTE when querying a calculated measure that references semi-additive measures', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/windowed_data AS/i);
    expect(sql).toMatch(/MAX\("_score1__exam_date_for_ordering"\) OVER/i);
    expect(sql).toMatch(/MIN\("_score1__exam_date_for_ordering"\) OVER/i);
    expect(sql).not.toMatch(/sum\("score1"\.score\)\s*\/\s*count\(distinct "score1"\.score\)/i);
  });

  it('orders calculated semi-additive measure by alias on MySQL (q_0 wrap)', async () => {
    await compiler.compile();

    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
        order: [{ id: 'score1.fuhezhibiao', desc: true }],
        limit: 100,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/AS q_0[\s\S]*ORDER BY `score1__fuhezhibiao` IS NULL ASC, `score1__fuhezhibiao` DESC/i);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*sum\("score1"\.score\)/i);
  });

  it('orders calculated semi-additive measure by alias on Postgres (q_0 wrap)', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
        order: [{ id: 'score1.fuhezhibiao', desc: true }],
        limit: 100,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/(?:AS )?q_0[\s\S]*ORDER BY "score1__fuhezhibiao" DESC NULLS LAST/i);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*sum\("score1"\.score\)/i);
  });

  it('orders calculated semi-additive measure by alias on DM (q_0 wrap)', async () => {
    await compiler.compile();

    const query = new DmQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
        order: [{ id: 'score1.fuhezhibiao', desc: true }],
        limit: 100,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/(?:AS )?q_0[\s\S]*ORDER BY "score1__fuhezhibiao" DESC NULLS LAST/i);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*sum\("score1"\.score\)/i);
  });
});

describe('semi-additive windowGroupings dimensions in base_data', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`facts\`, {
      sql: \`SELECT * FROM xss.cube_metrics_facts\`,

      dimensions: {
        city: {
          sql: \`\${CUBE}.city\`,
          type: 'string',
        },
        cityCode: {
          sql: \`\${CUBE}.city_code\`,
          type: 'string',
        },
        statDt: {
          sql: \`\${CUBE}.stat_dt\`,
          type: 'time',
        },
      },

      measures: {
        balanceEnd: {
          sql: \`\${CUBE}.balance_snapshot\`,
          type: 'sum',
          nonAdditiveDimension: {
            name: 'statDt',
            windowChoice: 'max',
            windowGroupings: ['city'],
          },
        },
      },
    })
  `);

  it('projects windowGroupings dimensions into base_data even when not in query dimensions', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['facts.balanceEnd'],
        dimensions: ['facts.cityCode'],
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/"facts__city"/i);
    expect(sql).toMatch(/"facts__city_code"/i);
    expect(sql).toMatch(/PARTITION BY "facts__city"/i);
  });
});
