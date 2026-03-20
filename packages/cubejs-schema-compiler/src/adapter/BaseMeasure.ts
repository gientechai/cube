import { UserError } from '../compiler/UserError';
import type { BaseQuery } from './BaseQuery';
import { MeasureDefinition, NonAdditiveDimensionConfig } from '../compiler/CubeEvaluator';
import { CubeSymbols } from '../compiler/CubeSymbols';

export class BaseMeasure {
  public readonly expression: any;

  public readonly expressionCubeName: any;

  public readonly expressionName: any;

  public readonly isMemberExpression: boolean = false;

  protected readonly patchedMeasure: MeasureDefinition | null = null;

  public readonly joinHint: Array<string> = [];

  /**
   * 非可加维度配置
   * 如果配置了此项，该 measure 将被视为半累加指标
   */
  public readonly nonAdditiveConfig: NonAdditiveDimensionConfig | null = null;

  protected preparePatchedMeasure(sourceMeasure: string, newMeasureType: string | null, addFilters: Array<{sql: Function}>): MeasureDefinition {
    const source = this.query.cubeEvaluator.measureByPath(sourceMeasure);
    const aggType = source.aggType ?? source.type;

    let resultMeasureType = aggType;
    if (newMeasureType !== null) {
      switch (aggType) {
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
          switch (newMeasureType) {
            case 'sum':
            case 'avg':
            case 'min':
            case 'max':
            case 'count_distinct':
            case 'countDistinct':
            case 'count_distinct_approx':
            case 'countDistinctApprox':
              // Can change from avg/... to count_distinct
              // Latter does not care what input value is
              // ok, do nothing
              break;
            default:
              throw new UserError(
                `Unsupported measure type replacement for ${sourceMeasure}: ${aggType} => ${newMeasureType}`
              );
          }
          break;
        case 'count_distinct':
        case 'countDistinct':
        case 'count_distinct_approx':
        case 'countDistinctApprox':
          switch (newMeasureType) {
            case 'count_distinct':
            case 'countDistinct':
            case 'count_distinct_approx':
            case 'countDistinctApprox':
              // ok, do nothing
              break;
            default:
              // Can not change from count_distinct to avg/...
              // Latter do care what input value is, and original measure can be defined on strings
              throw new UserError(
                `Unsupported measure type replacement for ${sourceMeasure}: ${aggType} => ${newMeasureType}`
              );
          }
          break;
        default:
          // Can not change from string, time, boolean, number
          // Aggregation is already included in SQL, it's hard to patch that
          // Can not change from count
          // There's no SQL at all
          throw new UserError(
            `Unsupported measure type replacement for ${sourceMeasure}: ${aggType} => ${newMeasureType}`
          );
      }

      resultMeasureType = newMeasureType;
    }

    const resultFilters = source.filters ?? [];

    if (addFilters.length > 0) {
      switch (resultMeasureType) {
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
        case 'count':
        case 'count_distinct':
        case 'countDistinct':
        case 'count_distinct_approx':
        case 'countDistinctApprox':
          // ok, do nothing
          break;
        default:
          // Can not add filters to string, time, boolean, number
          // Aggregation is already included in SQL, it's hard to patch that
          throw new UserError(
            `Unsupported additional filters for measure ${sourceMeasure} type ${aggType}`
          );
      }

      resultFilters.push(...addFilters);
    }

    const patchedFrom = this.query.cubeEvaluator.parsePath('measures', sourceMeasure);

    // For view measures, `type` is `number` (aggregation is embedded in SQL)
    // while `aggType` carries the real aggregation kind. We must preserve that
    // distinction to avoid double-wrapping (e.g. SUM(SUM(...))).
    const typeFields = source.aggType != null
      ? { type: source.type, aggType: resultMeasureType }
      : { type: resultMeasureType };

    return {
      ...source,
      ...typeFields,
      filters: resultFilters,
      patchedFrom: {
        cubeName: patchedFrom[0],
        name: patchedFrom[1],
      },
    };
  }

  public constructor(
    protected readonly query: BaseQuery,
    public readonly measure: any
  ) {
    if (measure.expression) {
      this.expression = measure.expression;
      this.expressionCubeName = measure.cubeName;
      // In case of SQL push down expressionName doesn't contain cube name. It's just a column name.
      this.expressionName = measure.expressionName || `${measure.cubeName}.${measure.name}`;
      this.isMemberExpression = !!measure.definition;

      if (measure.expression.type === 'PatchMeasure') {
        this.patchedMeasure = this.preparePatchedMeasure(
          measure.expression.sourceMeasure,
          measure.expression.replaceAggregationType,
          measure.expression.addFilters,
        );
      }
    } else {
      // TODO move this `as` to static types
      const measurePath = measure as string;
      const { path, joinHint } = CubeSymbols.joinHintFromPath(measurePath);
      this.measure = path;
      this.joinHint = joinHint;
    }

    // 提取非可加维度配置
    const definition = this.measureDefinition();
    if (definition.nonAdditiveDimension) {
      this.nonAdditiveConfig = definition.nonAdditiveDimension;
    }
  }

  /**
   * 判断是否为半累加指标
   *
   * @returns {boolean}
   */
  public isSemiAdditive(): boolean {
    return !!this.nonAdditiveConfig;
  }

  public getMembers() {
    return [this];
  }

  public selectColumns() {
    // 对于半累加指标，如果查询已经包含聚合（在 CTE 中），
    // 则直接返回列名，而不是重新计算聚合
    if (this.isSemiAdditive()) {
      // 检查查询是否已经处理了半累加指标（通过检查上下文）
      // 如果是，则只返回列名
      return [`${this.aliasName()}`];
    }
    return [`${this.measureSql()} ${this.aliasName()}`];
  }

  public hasNoRemapping() {
    return this.measureSql() === this.aliasName();
  }

  public cumulativeSelectColumns() {
    return [`${this.cumulativeMeasureSql()} ${this.aliasName()}`];
  }

  public cumulativeMeasureSql() {
    return this.query.evaluateSymbolSqlWithContext(
      () => this.measureSql(),
      {
        ungroupedAliasesForCumulative: { [this.measure]: this.aliasName() }
      }
    );
  }

  public measureSql() {
    // 处理表达式类型的 measure
    if (this.expression) {
      return this.convertTzForRawTimeDimensionIfNeeded(() => this.query.evaluateSymbolSql(this.expressionCubeName, this.expressionName, this.definition(), 'measure'));
    }

    // 处理半累加指标
    if (this.isSemiAdditive()) {
      return this.semiAdditiveMeasureSql();
    }

    // 常规指标
    return this.query.measureSql(this);
  }

  // We need this for measures however we don't for filters for performance reasons
  public convertTzForRawTimeDimensionIfNeeded(sql) {
    if (this.query.options.convertTzForRawTimeDimension) {
      return this.query.evaluateSymbolSqlWithContext(sql, {
        convertTzForRawTimeDimension: true
      });
    } else {
      return sql();
    }
  }

  public cube() {
    if (this.expression) {
      return this.query.cubeEvaluator.cubeFromPath(this.expressionCubeName);
    }
    return this.query.cubeEvaluator.cubeFromPath(this.measure);
  }

  public measureDefinition() {
    if (this.patchedMeasure) {
      return this.patchedMeasure;
    }
    return this.query.cubeEvaluator.measureByPath(this.measure);
  }

  public definition(): any {
    if (this.patchedMeasure) {
      return this.patchedMeasure;
    }
    if (this.expression) {
      return {
        sql: this.expression,
        // TODO use actual measure type even though it isn't used right now
        type: 'number'
      };
    }
    return this.measureDefinition();
  }

  public aliasName(): string {
    return this.query.escapeColumnName(this.unescapedAliasName());
  }

  public unescapedAliasName(): string {
    if (this.expression) {
      return this.query.aliasName(this.expressionName);
    }
    return this.query.aliasName(this.measure);
  }

  public isCumulative(): boolean {
    if (this.expression) { // TODO
      return false;
    }
    return BaseMeasure.isCumulative(this.measureDefinition());
  }

  public isMultiStage(): boolean {
    if (this.expression) { // TODO
      return false;
    }
    return this.definition().multiStage;
  }

  public isAdditive(): boolean {
    if (this.expression) { // TODO
      return false;
    }

    // 如果配置了非可加维度，则不是完全可加的
    if (this.isSemiAdditive()) {
      return false;
    }

    const definition = this.measureDefinition();
    if (definition.multiStage) {
      return false;
    }
    return definition.type === 'sum' || definition.type === 'count' || definition.type === 'countDistinctApprox' ||
      definition.type === 'min' || definition.type === 'max';
  }

  public static isCumulative(definition): boolean {
    return definition.type === 'runningTotal' || !!definition.rollingWindow;
  }

  public rollingWindowDefinition() {
    if (this.measureDefinition().type === 'runningTotal') {
      throw new UserError('runningTotal rollups aren\'t supported. Please consider replacing runningTotal measure with rollingWindow.');
    }
    const { type } = this.measureDefinition().rollingWindow;
    if (type && type !== 'fixed') {
      throw new UserError(`Only fixed rolling windows are supported by Cube Store but got '${type}' rolling window`);
    }
    return this.measureDefinition().rollingWindow;
  }

  public dateJoinCondition() {
    const definition = this.measureDefinition();
    if (definition.type === 'runningTotal') {
      return this.query.runningTotalDateJoinCondition();
    }
    const { rollingWindow } = definition;
    if (rollingWindow.type === 'to_date') {
      return this.query.rollingWindowToDateJoinCondition(rollingWindow.granularity);
    }
    // TODO deprecated
    if (rollingWindow.type === 'year_to_date' || rollingWindow.type === 'quarter_to_date' || rollingWindow.type === 'month_to_date') {
      return this.query.rollingWindowToDateJoinCondition(rollingWindow.type.replace('_to_date', ''));
    }
    if (rollingWindow) {
      return this.query.rollingWindowDateJoinCondition(
        rollingWindow.trailing, rollingWindow.leading, rollingWindow.offset
      );
    }
    return null;
  }

  public windowGranularity() {
    const { rollingWindow } = this.measureDefinition();
    if (rollingWindow) {
      return this.minGranularity(
        this.granularityFromInterval(rollingWindow.leading),
        this.granularityFromInterval(rollingWindow.trailing)
      );
    }
    return undefined;
  }

  public minGranularity(granularityA: string | undefined, granularityB: string | undefined) {
    return this.query.minGranularity(granularityA, granularityB);
  }

  public granularityFromInterval(interval: string): string | undefined {
    if (!interval) {
      return undefined;
    }
    if (interval.match(/day/)) {
      return 'day';
    } else if (interval.match(/month/)) {
      return 'month';
    } else if (interval.match(/year/)) {
      return 'year';
    } else if (interval.match(/week/)) {
      return 'week';
    } else if (interval.match(/hour/)) {
      return 'hour';
    }
    return undefined;
  }

  public shouldUngroupForCumulative(): boolean {
    return this.measureDefinition().rollingWindow && !this.isAdditive();
  }

  public sqlDefinition() {
    return this.measureDefinition().sql;
  }

  public path(): string[] | null {
    if (this.expression) {
      return null;
    }
    return this.query.cubeEvaluator.parsePath('measures', this.measure);
  }

  public expressionPath(): string {
    if (this.expression) {
      return `expr:${this.expressionName}`;
    }

    const path = this.path();
    if (path === null) {
      // Sanity check, this should not actually happen because we checked this.expression earlier
      throw new Error('Unexpected null path');
    }
    return this.query.cubeEvaluator.pathFromArray(path);
  }

  /**
   * 生成半累加指标的 SQL
   *
   * 在 CTE 上下文中，引用 windowed_data CTE 中已经计算的窗口函数结果
   * 在非 CTE 上下文中，使用窗口函数直接生成 SQL
   *
   * @private
   * @returns {string}
   */
  private semiAdditiveMeasureSql(): string {
    const config = this.nonAdditiveConfig!;
    const measureType = this.measureDefinition().type;
    const aggregateType = measureType.toUpperCase();

    // 检查是否在 CTE 上下文中（通过检查是否有特定的列别名）
    // 在 CTE 上下文中，应该使用 windowed_data CTE 中已经计算的列
    const timeDimColumn = this.query.getSemiAdditiveTimeDimensionColumn &&
      this.query.getSemiAdditiveTimeDimensionColumn(this, config, [config.name]);

    if (timeDimColumn) {
      // CTE 上下文：使用 windowed_data 中已经计算的窗口函数结果
      const rawColumn = this.query.escapeColumnName(`_${this.unescapedAliasName()}_raw`);
      const minDsColumn = this.query.escapeColumnName(`${this.unescapedAliasName()}_min_ds`);

      // 生成过滤表达式：CASE WHEN time_dimension = min_ds THEN raw_value ELSE NULL END
      const filterExpression = `CASE WHEN ${timeDimColumn} = (${minDsColumn}) THEN ${rawColumn} ELSE NULL END`;

      // 应用聚合函数
      // 对于 count_distinct 类型，使用 query 的 renderSqlMeasure 方法以确保数据库特定的语法
      // 这样可以支持 ClickHouse 的 uniqExact() 等数据库特定函数
      let sumExpression: string;
      if (measureType === 'count_distinct' || measureType === 'countDistinct') {
        // 使用 query 的 renderSqlMeasure 方法，它会根据数据库类型生成正确的语法
        // 对于大多数数据库是 COUNT(DISTINCT ...)，对于 ClickHouse 可能是 uniqExact(...)
        const symbol = this.measureDefinition();
        sumExpression = this.query.renderSqlMeasure(
          this.measure.split('.').pop() || this.measure,
          filterExpression,
          { ...symbol, type: 'countDistinct' },
          this.cube().name,
          null,
          []
        );
      } else {
        sumExpression = `${aggregateType}(${filterExpression})`;
      }

      // 对 SUM 和 COUNT 使用 COALESCE
      if (aggregateType === 'SUM' || aggregateType === 'COUNT' || measureType === 'count_distinct' || measureType === 'countDistinct') {
        return `COALESCE(${sumExpression}, 0)`;
      }

      return sumExpression;
    } else {
      // 非 CTE 上下文：直接生成窗口函数
      // 获取基础 SQL（未聚合的值表达式）
      const baseSql = this.query.evaluateSymbolSql(
        this.query.cubeEvaluator.cubeFromPath(this.measure),
        this.measure,
        this.measureDefinition(),
        'measure'
      );

      // 获取时间维度 SQL
      const cubeName = this.cube().name;
      const dimensionPath = config.name.includes('.') ? config.name : `${cubeName}.${config.name}`;
      const dimension = this.query.newDimension(dimensionPath);
      const dimensionSql = this.query.dimensionSql(dimension);

      // 构建 PARTITION BY 子句
      const partitionBy = this.buildPartitionByForMeasure(config);

      // 根据窗口选择类型生成窗口函数
      let windowFunc: string;
      if (config.windowChoice === 'min' || config.windowChoice === 'first') {
        windowFunc = `MIN(${dimensionSql}) OVER (${partitionBy})`;
      } else if (config.windowChoice === 'max' || config.windowChoice === 'last') {
        windowFunc = `MAX(${dimensionSql}) OVER (${partitionBy})`;
      } else {
        throw new UserError(`Unsupported window choice for semi-additive measure: ${config.windowChoice}`);
      }

      // 生成过滤表达式
      const filterExpression = `CASE WHEN ${dimensionSql} = (${windowFunc}) THEN ${baseSql} ELSE NULL END`;
      
      // 对于 count_distinct 类型，使用 query 的 renderSqlMeasure 方法以确保数据库特定的语法
      let sumExpression: string;
      if (measureType === 'count_distinct' || measureType === 'countDistinct') {
        // 使用 query 的 renderSqlMeasure 方法，它会根据数据库类型生成正确的语法
        const symbol = this.measureDefinition();
        sumExpression = this.query.renderSqlMeasure(
          this.measure.split('.').pop() || this.measure,
          filterExpression,
          { ...symbol, type: 'countDistinct' },
          this.cube().name,
          null,
          []
        );
      } else {
        sumExpression = `${aggregateType}(${filterExpression})`;
      }

      if (aggregateType === 'SUM' || aggregateType === 'COUNT' || measureType === 'count_distinct' || measureType === 'countDistinct') {
        return `COALESCE(${sumExpression}, 0)`;
      }

      return sumExpression;
    }
  }

  /**
   * 构建 PARTITION BY 子句
   *
   * @private
   * @param {NonAdditiveDimensionConfig} config
   * @returns {string}
   */
  private buildPartitionByForMeasure(config: NonAdditiveDimensionConfig): string {
    const clauses: string[] = [];

    // 尝试从多个来源获取粒度信息
    let granularity: string | null = null;
    let dimensionSql: string | null = null;

    // 方法1: 从 this.query.timeDimensions 获取
    if (this.query.timeDimensions && this.query.timeDimensions.length > 0) {
      const timeDimension = this.query.timeDimensions.find(
        (td: any) => {
          const dimensionName = td.dimension;
          const cubeName = this.measure.cubeName || this.measure;
          return dimensionName === config.name ||
                 dimensionName === `${cubeName}.${config.name}` ||
                 dimensionName.endsWith(`.${config.name}`);
        }
      );

      if (timeDimension && (timeDimension as any).granularity) {
        granularity = (timeDimension as any).granularity;
        // 构建完整的维度路径并创建维度对象
        const cubeName = this.cube().name;
        const dimensionPath = config.name.includes('.') ? config.name : `${cubeName}.${config.name}`;
        const dimension = this.query.newDimension(dimensionPath);
        dimensionSql = this.query.dimensionSql(dimension);
      }
    }

    // 方法2: 如果方法1失败，尝试从 this.query.dimensionsForSelect() 获取
    if (!granularity && this.query.dimensionsForSelect) {
      const dimensions = this.query.dimensionsForSelect();
      const matchingDim = dimensions.find((d: any) => {
        const dimPath = d.dimension || `${d.cube().name}.${d.name}`;
        const cubeName = this.measure.cubeName || this.measure;
        const dimensionPath = config.name.includes('.') ? config.name : `${cubeName}.${config.name}`;
        return dimPath === dimensionPath || dimPath.endsWith(`.${config.name}`);
      });

      if (matchingDim && (matchingDim as any).granularity) {
        granularity = (matchingDim as any).granularity;
        // 对于已经在 dimensionsForSelect 中的维度，使用其别名
        dimensionSql = matchingDim.aliasName();
      }
    }

    // 如果找到了粒度和维度SQL，添加到PARTITION BY子句
    if (granularity && dimensionSql) {
      // 使用 timeGroupedColumn 方法生成时间分组表达式
      // 如果dimensionSql已经是列别名（来自dimensionsForSelect），直接使用
      // 否则使用timeGroupedColumn方法
      const partitionExpr = dimensionSql.includes('__') ?
        dimensionSql :
        this.query.timeGroupedColumn(granularity, dimensionSql);
      clauses.push(partitionExpr);
    }

    // 添加 windowGroupings
    if (config.windowGroupings) {
      config.windowGroupings.forEach(grouping => {
        // 构建完整的维度路径并创建维度对象
        const cubeName = this.cube().name;
        const groupingPath = grouping.includes('.') ? grouping : `${cubeName}.${grouping}`;
        const dimension = this.query.newDimension(groupingPath);
        clauses.push(this.query.dimensionSql(dimension));
      });
    }

    return clauses.length > 0 ? `PARTITION BY ${clauses.join(', ')}` : '';
  }
}
