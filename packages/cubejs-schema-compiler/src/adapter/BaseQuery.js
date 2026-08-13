/* eslint-disable no-unused-vars,prefer-template */

/**
 * @fileoverview BaseQuery class definition.
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 */

import cronParser from 'cron-parser';
import inflection from 'inflection';
import moment from 'moment-timezone';
import R from 'ramda';

import {
  buildSqlAndParams as nativeBuildSqlAndParams,
} from '@cubejs-backend/native';
import {
  FROM_PARTITION_RANGE,
  MAX_SOURCE_ROW_LIMIT,
  QueryAlias,
  getEnv,
  localTimestampToUtc,
  timeSeries as timeSeriesBase,
  timeSeriesFromCustomInterval,
  findMinGranularityDimension
} from '@cubejs-backend/shared';

import { CubeSymbols } from '../compiler/CubeSymbols';
import { UserError } from '../compiler/UserError';
import { SqlParser } from '../parser/SqlParser';
import { BaseDimension } from './BaseDimension';
import { BaseFilter } from './BaseFilter';
import { BaseGroupFilter } from './BaseGroupFilter';
import { BaseMeasure } from './BaseMeasure';
import { BaseSegment } from './BaseSegment';
import { BaseTimeDimension } from './BaseTimeDimension';
import { Granularity } from './Granularity';
import { ParamAllocator } from './ParamAllocator';
import { PreAggregations } from './PreAggregations';

const DEFAULT_PREAGGREGATIONS_SCHEMA = 'stb_pre_aggregations';

const standardGranularitiesParents = {
  year: ['year', 'quarter', 'month', 'day', 'hour', 'minute', 'second'],
  quarter: ['quarter', 'month', 'day', 'hour', 'minute', 'second'],
  month: ['month', 'day', 'hour', 'minute', 'second'],
  week: ['week', 'day', 'hour', 'minute', 'second'],
  day: ['day', 'hour', 'minute', 'second'],
  hour: ['hour', 'minute', 'second'],
  minute: ['minute', 'second'],
  second: ['second']
};

const SecondsDurations = {
  week: 60 * 60 * 24 * 7,
  day: 60 * 60 * 24,
  hour: 60 * 60,
  minute: 60,
  second: 1
};

/**
 * Set of the schema compilers.
 * @typedef {Object} Compilers
 * @property {import('../compiler/DataSchemaCompiler').DataSchemaCompiler} compiler
 * @property {import('../compiler/CubeToMetaTransformer').CubeToMetaTransformer} metaTransformer
 * @property {import('../compiler/CubeEvaluator').CubeEvaluator} cubeEvaluator
 * @property {import('../compiler/ContextEvaluator').ContextEvaluator} contextEvaluator
 * @property {import('../compiler/JoinGraph').JoinGraph} joinGraph
 * @property {import('../compiler/CompilerCache').CompilerCache} compilerCache
 * @property {*} headCommitId
 */

/**
 * @typedef {Object} JoinRoot
 * @property {string} sql
 * @property {string} alias
 */

/**
 * @typedef {Object} JoinItem
 * @property {string} sql
 * @property {string} alias
 * @property {string} on
 */

/**
 * @typedef {[JoinRoot, ...JoinItem]} JoinChain
 */

/**
 * BaseQuery class. BaseQuery object encapsulates the logic of
 * transforming an incoming to a specific cube request to the
 * SQL-query string.
 *
 * This class is a parent class for the set of dialect specific
 * query adapters (for ex. MysqlQuery, OracleQuery, etc.).
 *
 * You should never instantiate this class manually. Instead, you
 * should use {@code CompilerApi#getDialectClass} method, which
 * should return query object based on the datasource, database type
 * and {@code CompilerApi} configuration.
 */
export class BaseQuery {
  /** @type {import('./PreAggregations').PreAggregations} */
  preAggregations;

  /** @type {import('./BaseMeasure').BaseMeasure[]} */
  measures;

  /** @type {import('./BaseDimension').BaseDimension[]} */
  dimensions;

  /** @type {import('./BaseDimension').BaseDimension[]} */
  multiStageDimensions;

  /** @type {import('./BaseTimeDimension').BaseTimeDimension[]} */
  multiStageTimeDimensions;

  /** @type {import('./BaseSegment').BaseSegment[]} */
  segments;

  /** @type {(BaseFilter|BaseGroupFilter)[]} */
  filters;

  /** @type {(BaseFilter|BaseGroupFilter)[]} */
  measureFilters;

  /** @type {import('./BaseTimeDimension').BaseTimeDimension[]} */
  timeDimensions;

  /** @type {import('../compiler/JoinGraph').FinishedJoinTree} */
  join;

  /**
   * BaseQuery class constructor.
   * @param {Compilers|*} compilers
   * @param {*} options
   */
  constructor(compilers, options) {
    this.compilers = compilers;
    /** @type {import('../compiler/CubeEvaluator').CubeEvaluator} */
    this.cubeEvaluator = compilers.cubeEvaluator;
    /** @type {import('../compiler/JoinGraph').JoinGraph} */
    this.joinGraph = compilers.joinGraph;
    this.options = options || {};

    this.orderHashToString = this.orderHashToString.bind(this);
    this.defaultOrder = this.defaultOrder.bind(this);
    /** @type {boolean} set while generating multi-subquery JOIN ORDER BY */
    this.orderByJoinAmbiguity = false;
    /** @type {ParamAllocator} */
    this.paramAllocator = this.options.paramAllocator || this.newParamAllocator(this.options.expressionParams);
    this.initFromOptions();
  }

  extractDimensionsAndMeasures(filters = []) {
    if (!filters) {
      return [];
    }
    let allFilters = [];
    filters.forEach(f => {
      if (f.and) {
        allFilters = allFilters.concat(this.extractDimensionsAndMeasures(f.and));
      } else if (f.or) {
        allFilters = allFilters.concat(this.extractDimensionsAndMeasures(f.or));
      } else if (!f.member && !f.dimension) {
        throw new UserError(`member attribute is required for filter ${JSON.stringify(f)}`);
      } else if (this.cubeEvaluator.isMeasure(f.member || f.dimension)) {
        allFilters.push({ measure: f.member || f.dimension });
      } else {
        allFilters.push({ dimension: f.member || f.dimension });
      }
    });

    return allFilters;
  }

  keepFilters(filters = [], fn) {
    return filters.map(f => {
      if (f.and) {
        return { and: this.keepFilters(f.and, fn) };
      } else if (f.or) {
        return { or: this.keepFilters(f.or, fn) };
      } else if (!f.member && !f.dimension) {
        throw new UserError(`member attribute is required for filter ${JSON.stringify(f)}`);
      } else {
        return fn(f.member || f.dimension || f.measure) ? f : null;
      }
    }).filter(f => !!f);
  }

  extractFiltersAsTree(filters = []) {
    if (!filters) {
      return [];
    }

    return filters.map(f => {
      if (f.and || f.or) {
        let operator = 'or';
        if (f.and) {
          operator = 'and';
        }
        const data = this.extractDimensionsAndMeasures(f[operator]);
        const dimension = data.filter(e => !!e.dimension).map(e => e.dimension);
        const measure = data.filter(e => !!e.measure).map(e => e.measure);
        if (dimension.length && !measure.length) {
          return {
            values: this.extractFiltersAsTree(f[operator]),
            operator,
            dimensionGroup: true,
            measure: null,
          };
        }
        if (!dimension.length && measure.length) {
          return {
            values: this.extractFiltersAsTree(f[operator]),
            operator,
            dimension: null,
            measureGroup: true,
          };
        }
        if (!dimension.length && !measure.length) {
          return {
            values: [],
            operator,
          };
        }
        throw new UserError(`You cannot use dimension and measure in same condition: ${JSON.stringify(f)}`);
      }

      if (!f.member && !f.dimension) {
        throw new UserError(`member attribute is required for filter ${JSON.stringify(f)}`);
      }

      if (this.cubeEvaluator.isMeasure(f.member || f.dimension)) {
        return Object.assign({}, f, {
          dimension: null,
          measure: f.member || f.dimension
        });
      }

      return Object.assign({}, f, {
        measure: null,
        dimension: f.member || f.dimension
      });
    });
  }

  /**
   * @protected
   */
  initFromOptions() {
    this.contextSymbols = {
      securityContext: {},
      ...this.options.contextSymbols,
    };
    this.maskedMembers = new Set();
    this.resultMaskedMembers = new Set();
    this.memberMaskFilters = {};
    for (const item of this.options.maskedMembers || []) {
      this.maskedMembers.add(item.member);
      if (item.filter) {
        this.memberMaskFilters[item.member] = item.filter;
      }
    }
    for (const item of this.options.resultMaskedMembers || []) {
      this.resultMaskedMembers.add(item.member);
      if (item.filter && !this.memberMaskFilters[item.member]) {
        this.memberMaskFilters[item.member] = item.filter;
      }
    }
    this.compilerCache = this.compilers.compiler.compilerCache;
    if (this.options.timeDimensions?.length) {
      this.options.timeDimensions = this.options.timeDimensions.map((td) =>
        this.normalizeTimeDimensionInput(td)
      );
    }
    this.queryCache = this.compilerCache.getQueryCache({
      measures: this.options.measures,
      dimensions: this.options.dimensions,
      timeDimensions: this.options.timeDimensions,
      filters: this.options.filters,
      segments: this.options.segments,
      order: this.options.order,
      contextSymbols: this.options.contextSymbols,
      timezone: this.options.timezone,
      limit: this.options.limit,
      offset: this.options.offset,
      rowLimit: this.options.rowLimit,
      preAggregationsSchema: this.options.preAggregationsSchema,
      className: this.constructor.name,
      externalClassName: this.options.externalQueryClass?.name,
      preAggregationQuery: this.options.preAggregationQuery,
      disableExternalPreAggregations: this.options.disableExternalPreAggregations,
      useOriginalSqlPreAggregationsInPreAggregation: this.options.useOriginalSqlPreAggregationsInPreAggregation,
      cubeLatticeCache: this.options.cubeLatticeCache, // TODO too heavy for key
      historyQueries: this.options.historyQueries, // TODO too heavy for key
      ungrouped: this.options.ungrouped,
      memberToAlias: this.options.memberToAlias,
      expressionParams: this.options.expressionParams,
      convertTzForRawTimeDimension: this.options.convertTzForRawTimeDimension,
      from: this.options.from,
      multiStageQuery: this.options.multiStageQuery,
      multiStageDimensions: this.options.multiStageDimensions,
      multiStageTimeDimensions: this.options.multiStageTimeDimensions,
      subqueryJoins: this.options.subqueryJoins,
      joinHints: this.options.joinHints,
      maskedMembers: this.options.maskedMembers,
      resultMaskedMembers: this.options.resultMaskedMembers,
    });
    this.from = this.options.from;
    this.multiStageQuery = this.options.multiStageQuery;
    this.timezone = this.options.timezone;
    this.rowLimit = this.options.rowLimit;
    this.offset = this.options.offset;
    /** @type {import('./PreAggregations').PreAggregations} */
    this.preAggregations = this.newPreAggregations();
    /** @type {import('./BaseMeasure').BaseMeasure[]} */
    this.measures = (this.options.measures || []).map(this.newMeasure.bind(this));
    /** @type {import('./BaseDimension').BaseDimension[]} */
    this.dimensions = (this.options.dimensions || []).map(this.newDimension.bind(this));
    /** @type {import('./BaseDimension').BaseDimension[]} */
    this.multiStageDimensions = (this.options.multiStageDimensions || []).map(this.newDimension.bind(this));
    /** @type {import('./BaseTimeDimension').BaseTimeDimension[]} */
    this.multiStageTimeDimensions = (this.options.multiStageTimeDimensions || []).map(this.newTimeDimension.bind(this));
    /** @type {import('./BaseSegment').BaseSegment[]} */
    this.segments = (this.options.segments || []).map(this.newSegment.bind(this));

    const filters = this.extractFiltersAsTree(this.options.filters || []);

    // measure_filter (the one extracted from filters parameter on measure and
    // used in drill-downs) should go to WHERE instead of HAVING.
    //
    // A grouped filter (and/or) whose every leaf is a measure_filter operator
    // is treated the same way: its leaves expand to base-table predicates via
    // measureFilterToWhere(), so it must be applied as a row-level WHERE (and,
    // for semi-additive CTEs, pushed down into base_data) rather than as an
    // outer HAVING that references columns unavailable in the outer scope.
    const isMeasureFilterGroup = (f) => {
      if (!f || (f.operator !== 'and' && f.operator !== 'or') || !Array.isArray(f.values)) {
        return false;
      }
      return f.values.length > 0 && f.values.every((leaf) => {
        if (leaf && (leaf.operator === 'and' || leaf.operator === 'or')) {
          return isMeasureFilterGroup(leaf);
        }
        return leaf && (leaf.operator === 'measure_filter' || leaf.operator === 'measureFilter');
      });
    };
    const isMeasureFilterBranch = (f) => f.dimensionGroup || f.dimension
      || f.operator === 'measure_filter' || f.operator === 'measureFilter'
      || isMeasureFilterGroup(f);
    /** @type {(BaseFilter|BaseGroupFilter)[]} */
    this.filters = filters.filter(isMeasureFilterBranch).map(this.initFilter.bind(this));
    /** @type {(BaseFilter|BaseGroupFilter)[]} */
    this.measureFilters = filters.filter(f => (f.measureGroup || f.measure) && !isMeasureFilterBranch(f)).map(this.initFilter.bind(this));
    /** @type {import('./BaseTimeDimension').BaseTimeDimension[]} */
    this.timeDimensions = (this.options.timeDimensions || []).map(dimension => {
      if (!dimension.dimension) {
        const join = this.joinGraph.buildJoin(this.collectJoinHints(true));
        if (!join) {
          return undefined;
        }

        // eslint-disable-next-line prefer-destructuring
        dimension.dimension = this.cubeEvaluator.timeDimensionPathsForCube(join.root)[0];
        if (!dimension.dimension) {
          return undefined;
        }
      }
      return dimension;
    }).filter(R.identity).map(this.newTimeDimension.bind(this));
    this.allFilters = this.timeDimensions.concat(this.segments).concat(this.filters);
    /**
     * For now this might come only from SQL API, it might be some queries that uses measures and filters to
     * get the dimensions that are then used as join conditions to get the final results.
     * As consequence - if there are such sub query joins - pre-aggregations can't be used.
     * @type {Array<{sql: string, on: {expression: Function}, joinType: 'LEFT' | 'INNER', alias: string}>}
     */
    this.customSubQueryJoins = this.options.subqueryJoins ?? [];
    this.useNativeSqlPlanner = this.options.useNativeSqlPlanner ?? getEnv('nativeSqlPlanner');
    this.canUseNativeSqlPlannerPreAggregation = getEnv('nativeSqlPlannerPreAggregations');
    if (this.useNativeSqlPlanner && !this.canUseNativeSqlPlannerPreAggregation && !this.neverUseSqlPlannerPreaggregation()) {
      const fullAggregateMeasures = this.fullKeyQueryAggregateMeasures({ hasMultipliedForPreAggregation: true });

      this.canUseNativeSqlPlannerPreAggregation = fullAggregateMeasures.multiStageMembers.length > 0;
    }
    this.queryLevelJoinHints = this.options.joinHints ?? [];
    this.prebuildJoin();

    this.cubeAliasPrefix = this.options.cubeAliasPrefix;
    this.preAggregationsSchemaOption = this.options.preAggregationsSchema ?? DEFAULT_PREAGGREGATIONS_SCHEMA;
    this.externalQueryClass = this.options.externalQueryClass;

    // Set the default order only when options.order is not provided at all
    // if options.order is set (empty array [] or with data) - use it as is
    this.order = this.options.order ?? this.defaultOrder();

    this.initUngrouped();
  }

  // Temporary workaround to avoid checking for multistage in CubeStoreQuery, since that could lead to errors when HLL functions are present in the query.
  neverUseSqlPlannerPreaggregation() {
    // The native planner determines a matching pre-aggregation by building the full
    // query SQL, which for a rolling-window measure includes its time series and
    // therefore requires a date range. The pre-aggregation refresh/metadata path
    // (e.g. the `/pre-aggregations` API) builds such a query with no date range, so
    // the native build throws "Date range is required for time series". Fall back to
    // the legacy planner for that case — it matches pre-aggregations structurally,
    // exactly as it did before Tesseract became the default.
    if (
      this.cumulativeMeasures().length > 0 &&
      !this.timeDimensions.some(td => td.dateRange)
    ) {
      return true;
    }
    return false;
  }

  prebuildJoin() {
    try {
      // TODO allJoinHints should contain join hints form pre-agg
      this.join = this.joinGraph.buildJoin(this.allJoinHints);
      /**
       * @type {Record<string, string[]>}
       */
      const queryJoinGraph = {};
      for (const { originalFrom, originalTo } of (this.join?.joins || [])) {
        if (!queryJoinGraph[originalFrom]) {
          queryJoinGraph[originalFrom] = [];
        }
        queryJoinGraph[originalFrom].push(originalTo);
      }
      this.joinGraphPaths = queryJoinGraph || {};
    } catch (e) {
      if (this.useNativeSqlPlanner) {
        // Tesseract doesn't require join to be prebuilt and there's a case where single join can't be built for multi-fact query
        // But we need this join for a fallback when using pre-aggregations. So we’ll try to obtain the join but ignore any errors (which may occur if the query is a multi-fact one).
      } else {
        throw e;
      }
    }
  }

  /**
   * This function follows the same logic as in this.collectJoinHints()
   * skipQueryJoinMap is used by PreAggregations to build join tree without user's query all members map
   * @public
   * @param {Array<(Array<string> | string)>} hints
   * @param { boolean } skipQueryJoinMap
   * @return {import('../compiler/JoinGraph').FinishedJoinTree}
   */
  joinTreeForHints(hints, skipQueryJoinMap = false) {
    const queryJoinMaps = skipQueryJoinMap ? {} : this.queryJoinMap();
    let newCollectedHints = [];

    const constructJH = () => R.uniq(this.enrichHintsWithJoinMap([
      ...newCollectedHints,
      ...hints,
    ],
    queryJoinMaps));

    let prevJoin = null;
    let newJoin = null;

    // Safeguard against infinite loop in case of cyclic joins somehow managed to slip through
    let cnt = 0;
    let newJoinHintsCollectedCnt;

    do {
      const allJoinHints = constructJH();
      prevJoin = newJoin;
      newJoin = this.joinGraph.buildJoin(allJoinHints);
      const allJoinHintsFlatten = new Set(allJoinHints.flat());
      const joinMembersJoinHints = this.collectJoinHintsFromMembers(this.joinMembersFromJoin(newJoin));

      const iterationCollectedHints = joinMembersJoinHints.filter(j => !allJoinHintsFlatten.has(j));
      newJoinHintsCollectedCnt = iterationCollectedHints.length;
      cnt++;
      if (newJoin && newJoin.joins.length > 0) {
        // Even if there is no join tree changes, we still
        // push correctly ordered join hints, collected from the resolving of members of join tree
        // upfront the all existing query members. This ensures the correct cube join order
        // with transitive joins even if they are already presented among query members.
        newCollectedHints = this.enrichedJoinHintsFromJoinTree(newJoin, joinMembersJoinHints);
      }
    } while (newJoin?.joins.length > 0 && !this.isJoinTreesEqual(prevJoin, newJoin) && cnt < 10000 && newJoinHintsCollectedCnt > 0);

    if (cnt >= 10000) {
      throw new UserError('Can not construct joins for the query, potential loop detected');
    }

    return this.joinGraph.buildJoin(constructJH());
  }

  cacheValue(key, fn, { contextPropNames, inputProps, cache } = {}) {
    const currentContext = this.safeEvaluateSymbolContext();
    if (contextPropNames) {
      const contextKey = {};
      for (const element of contextPropNames) {
        contextKey[element] = currentContext[element];
      }
      key = key.concat([JSON.stringify(contextKey)]);
    }
    const { value, resultProps } = (cache || this.compilerCache).cache(
      key,
      () => {
        if (inputProps) {
          return {
            value: this.evaluateSymbolSqlWithContext(fn, inputProps),
            resultProps: inputProps
          };
        }
        return { value: fn() };
      }
    );
    if (resultProps) {
      Object.keys(resultProps).forEach(k => {
        if (Array.isArray(currentContext[k])) {
          // eslint-disable-next-line prefer-spread
          currentContext[k].push.apply(currentContext[k], resultProps[k]);
        } else if (currentContext[k]) {
          Object.keys(currentContext[k]).forEach(innerKey => {
            currentContext[k][innerKey] = resultProps[k][innerKey];
          });
        }
      });
    }
    return value;
  }

  get allCubeNames() {
    if (!this.collectedCubeNames) {
      this.collectedCubeNames = this.collectCubeNames();
    }
    return this.collectedCubeNames;
  }

  /**
   *
   * @returns {Array<string | Array<string>>}
   */
  get allJoinHints() {
    if (!this.collectedJoinHints) {
      this.collectedJoinHints = this.collectJoinHints();
    }
    return this.collectedJoinHints;
  }

  /**
   * @private
   * @return { Record<string, string[][]>}
   */
  queryJoinMap() {
    const queryMembers = this.allMembersConcat(false);
    const joinMaps = {};

    for (const member of queryMembers) {
      const memberCube = member.cube?.();
      if (memberCube?.isView && !joinMaps[memberCube.name] && memberCube.joinMap) {
        joinMaps[memberCube.name] = memberCube.joinMap;
      }
    }

    return joinMaps;
  }

  /**
   * @private
   * @param { import('../compiler/JoinGraph').FinishedJoinTree } joinTree
   * @param { string[] } joinHints
   * @return { string[][] }
   */
  enrichedJoinHintsFromJoinTree(joinTree, joinHints) {
    const joinsMap = {};

    for (const j of joinTree.joins) {
      joinsMap[j.to] = j.from;
    }

    return joinHints.map(jh => {
      let cubeName = jh;
      const path = [cubeName];
      while (joinsMap[cubeName]) {
        cubeName = joinsMap[cubeName];
        path.push(cubeName);
      }

      if (path.length === 1) {
        return path[0];
      }
      return path.reverse();
    });
  }

  /**
   * @private
   * @param { (string|string[])[] } hints
   * @param { Record<string, string[][]>} joinMap
   * @return {(string|string[])[]}
   */
  enrichHintsWithJoinMap(hints, joinMap) {
    // Potentially, if joins between views would take place, we need to distinguish
    // join maps on per view basis.
    const allPaths = Object.values(joinMap).flat();

    return hints.map(hint => {
      if (Array.isArray(hint)) {
        return hint;
      }

      for (const path of allPaths) {
        const hintIndex = path.indexOf(hint);
        if (hintIndex !== -1) {
          return path.slice(0, hintIndex + 1);
        }
      }

      return hint;
    });
  }

  get dataSource() {
    const dataSources = R.uniq(this.allCubeNames.map(c => this.cubeDataSource(c)));
    if (dataSources.length > 1 && !this.externalPreAggregationQuery()) {
      throw new UserError(`To join across data sources use rollupJoin with Cube Store. If rollupJoin is defined, this error indicates it doesn't match the query. Please use Rollup Designer to verify it's definition. Found data sources: ${dataSources.join(', ')}`);
    }
    return dataSources[0];
  }

  cubeDataSource(cube) {
    return this.cubeEvaluator.cubeFromPath(cube).dataSource || 'default';
  }

  get aliasNameToMember() {
    return R.fromPairs(
      this.measures.map(m => [m.unescapedAliasName(), m.measure]).concat(
        this.dimensions.map(m => [m.unescapedAliasName(), m.dimension])
      ).concat(
        this.timeDimensions.filter(m => !!m.granularity)
          .map(m => [m.unescapedAliasName(), `${m.dimension}.${m.granularity}`])
      )
    );
  }

  initUngrouped() {
    this.ungrouped = this.options.ungrouped;
    if (this.ungrouped) {
      if (!this.options.allowUngroupedWithoutPrimaryKey && this.join) {
        const cubes = R.uniq([this.join.root].concat(this.join.joins.map(j => j.originalTo)));
        const primaryKeyNames = cubes.flatMap(c => this.primaryKeyNames(c));
        const missingPrimaryKeys = primaryKeyNames.filter(key => !this.dimensions.find(d => d.dimension === key));
        if (missingPrimaryKeys.length) {
          throw new UserError(`Ungrouped query requires primary keys to be present in dimensions: ${missingPrimaryKeys.map(k => `'${k}'`).join(', ')}. Pass allowUngroupedWithoutPrimaryKey option to disable this check.`);
        }
      }
      if (this.measureFilters.length) {
        throw new UserError('Measure filters aren\'t allowed in ungrouped query');
      }
    }
  }

  get subQueryDimensions() {
    // eslint-disable-next-line no-underscore-dangle
    if (!this._subQueryDimensions) {
      // eslint-disable-next-line no-underscore-dangle
      this._subQueryDimensions = this.collectFromMembers(
        false,
        this.collectSubQueryDimensionsFor.bind(this),
        'collectSubQueryDimensionsFor'
      );
    }
    // eslint-disable-next-line no-underscore-dangle
    return this._subQueryDimensions;
  }

  get asSyntaxTable() {
    return 'AS';
  }

  get asSyntaxJoin() {
    return 'AS';
  }

  defaultOrder() {
    if (this.options.preAggregationQuery || this.options.totalQuery) {
      return [];
    }

    const res = [];

    const granularity = this.timeDimensions.find(d => d.granularity);

    if (granularity) {
      res.push({
        id: granularity.dimension,
        desc: false,
      });
    } else if (this.measures.length > 0 && this.dimensions.length > 0) {
      const firstMeasure = this.measures[0];
      const id = firstMeasure.expressionName ?? firstMeasure.measure;

      res.push({ id, desc: true });
    } else if (this.dimensions.length > 0) {
      const dim = this.dimensions[0];
      res.push({
        id: dim.expressionName ?? dim.dimension,
        desc: false,
      });
    }

    return res;
  }

  /**
   *
   * @param measurePath
   * @returns {BaseMeasure}
   */
  newMeasure(measurePath) {
    return new BaseMeasure(this, measurePath);
  }

  /**
   *
   * @param dimensionPath
   * @returns {BaseDimension}
   */
  newDimension(dimensionPath) {
    if (typeof dimensionPath === 'string') {
      const memberArr = dimensionPath.split('.');
      if (memberArr.length > 3 &&
            memberArr[memberArr.length - 2] === 'granularities' &&
            this.cubeEvaluator.isDimension(memberArr.slice(0, -2))) {
        return this.newTimeDimension(
          {
            dimension: this.cubeEvaluator.pathFromArray(memberArr.slice(0, -2)),
            granularity: memberArr[memberArr.length - 1]
          }
        );
      }
    }
    return new BaseDimension(this, dimensionPath);
  }

  /**
   *
   * @param segmentPath
   * @returns {BaseSegment}
   */
  newSegment(segmentPath) {
    return new BaseSegment(this, segmentPath);
  }

  /**
   * @returns {BaseGroupFilter|BaseFilter}
   */
  initFilter(filter) {
    if (filter.operator === 'and' || filter.operator === 'or') {
      filter.values = filter.values.map(this.initFilter.bind(this));
      return this.newGroupFilter(filter);
    }

    return this.newFilter(filter);
  }

  /**
   * @returns {BaseFilter}
   */
  newFilter(filter) {
    return new BaseFilter(this, filter);
  }

  /**
   *
   * @param filter
   * @returns {BaseGroupFilter}
   */
  newGroupFilter(filter) {
    return new BaseGroupFilter(filter);
  }

  /**
   * @param timeDimension
   * @return {BaseTimeDimension}
   */
  newTimeDimension(timeDimension) {
    return new BaseTimeDimension(this, timeDimension);
  }

  /**
   *
   * @param expressionParams
   * @returns {ParamAllocator}
   */
  newParamAllocator(expressionParams) {
    return new ParamAllocator(expressionParams);
  }

  /**
   *
   * @returns {PreAggregations}
   */
  newPreAggregations() {
    return new PreAggregations(this, this.options.historyQueries || [], this.options.cubeLatticeCache);
  }

  /**
   * Wrap specified column/table name with the double quote.
   * @param {string} name
   * @returns {string}
   */
  escapeColumnName(name) {
    return `"${name}"`;
  }

  /**
   * Strip dialect quotes so escapeColumnName is not applied twice.
   *
   * @protected
   * @param {string} name
   * @returns {string}
   */
  unquotedColumnName(name) {
    if (typeof name !== 'string') {
      return name;
    }
    const quoteChars = ['`', '"'];
    for (const quote of quoteChars) {
      if (name.length >= 2 && name.startsWith(quote) && name.endsWith(quote)) {
        return name.slice(1, -1);
      }
    }
    return name;
  }

  /**
   * Returns SQL query string.
   * @returns {string}
   */
  buildParamAnnotatedSql() {
    let sql;
    let preAggForQuery;
    // TODO Most probably should be called later than here but avoids errors during pre-aggregation match for now
    // Semi-additive measures need row-level base table + regularMeasuresSubQuery (base_data/windowed_data).
    // simpleQuery() would only project aliases and skip that path when `from` wraps a prior CTE.
    // Calculated measures (type: number) may reference semi-additive base measures indirectly.
    if (this.from && !this.queryReferencesSemiAdditiveMeasures()) {
      return this.simpleQuery();
    }
    const hasMemberExpressions = this.allMembersConcat(false).some(m => m.isMemberExpression);

    if (!this.options.preAggregationQuery && !this.customSubQueryJoins.length && !hasMemberExpressions) {
      preAggForQuery =
        this.preAggregations.findPreAggregationForQuery();
      if (this.options.disableExternalPreAggregations && preAggForQuery?.preAggregation.external) {
        preAggForQuery = undefined;
      }
    }
    if (preAggForQuery) {
      const {
        multipliedMeasures,
        regularMeasures,
        cumulativeMeasures,
      } = this.fullKeyQueryAggregateMeasures();

      if (cumulativeMeasures.length === 0) {
        sql = this.preAggregations.rollupPreAggregation(
          preAggForQuery,
          this.measures,
          true,
        );
      } else {
        sql = this.regularAndTimeSeriesRollupQuery(
          regularMeasures,
          multipliedMeasures,
          cumulativeMeasures,
          preAggForQuery,
        );
      }
    } else {
      sql = this.fullKeyQueryAggregate();
    }
    return this.options.totalQuery
      ? this.countAllQuery(sql)
      : sql;
  }

  /**
   * Generate SQL query to calculate total number of rows of the
   * specified SQL query.
   * @param {string} sql
   * @returns {string}
   */
  countAllQuery(sql) {
    return `select count(*) ${this.escapeColumnName(QueryAlias.TOTAL_COUNT)
    } from (\n${sql
    }\n) ${this.escapeColumnName(QueryAlias.ORIGINAL_QUERY)
    }`;
  }

  regularAndTimeSeriesRollupQuery(regularMeasures, multipliedMeasures, cumulativeMeasures, preAggregationForQuery) {
    const regularAndMultiplied = regularMeasures.concat(multipliedMeasures);
    const toJoin =
      (regularAndMultiplied.length ? [
        this.withCubeAliasPrefix('main', () => this.preAggregations.rollupPreAggregation(preAggregationForQuery, regularAndMultiplied, false)),
      ] : []).concat(
        R.map(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ([multiplied, measure]) => this.withCubeAliasPrefix(
            `${this.aliasName(measure.measure.replace('.', '_'))}_cumulative`,
            () => this.overTimeSeriesQuery(
              (measures, filters) => this.preAggregations.rollupPreAggregation(
                preAggregationForQuery, measures, false, filters,
              ),
              measure,
              true,
            ),
          ),
        )(cumulativeMeasures),
      );
    return this.joinFullKeyQueryAggregate(multipliedMeasures, regularMeasures, cumulativeMeasures, toJoin);
  }

  externalPreAggregationQuery() {
    if (!this.options.preAggregationQuery && !this.options.disableExternalPreAggregations && this.externalQueryClass) {
      const preAggregationForQuery = this.preAggregations.findPreAggregationForQuery();
      if (preAggregationForQuery?.preAggregation.external) {
        return true;
      }
      const preAggregationsDescription = this.preAggregations.preAggregationsDescription();

      return preAggregationsDescription.length > 0 && R.all((p) => p.external, preAggregationsDescription);
    }

    return false;
  }

  newQueryWithoutNative() {
    const QueryClass = this.constructor;
    return new QueryClass(this.compilers, { ...this.options, useNativeSqlPlanner: false });
  }

  /**
   * Returns a pair of SQL query string and parameter values for the query.
   * @param {boolean} [exportAnnotatedSql] - returns annotated sql with not rendered params if true
   * @returns {[string, Array<unknown>]}
   */
  buildSqlAndParams(exportAnnotatedSql) {
    if (this.useNativeSqlPlanner) {
      let isRelatedToPreAggregation = false;

      if (!this.canUseNativeSqlPlannerPreAggregation) {
        if (this.options.preAggregationQuery) {
          isRelatedToPreAggregation = true;
        } else if (!this.options.disableExternalPreAggregations && this.externalQueryClass && this.externalPreAggregationQuery()) {
          isRelatedToPreAggregation = true;
        } else {
          let preAggForQuery =
            this.preAggregations.findPreAggregationForQuery();
          if (this.options.disableExternalPreAggregations && preAggForQuery && preAggForQuery.preAggregation.external) {
            preAggForQuery = undefined;
          }
          if (preAggForQuery) {
            isRelatedToPreAggregation = true;
          }
        }

        if (isRelatedToPreAggregation) {
          return this.newQueryWithoutNative().buildSqlAndParams(exportAnnotatedSql);
        }
      }

      // Tesseract 原生规划器目前不支持半累加指标（nonAdditiveDimension），
      // 需要回退到 JS 生成器以使用 CTE + 窗口函数的复杂逻辑。
      // 顶层 measure 可能是同比差值等 calculated（type: number），本身不是 semi-additive，
      // 但必须检测 collectAllMemberNames 是否包含 base_metric1 等半累加依赖。
      if (this.hasSemiAdditiveMeasures(this.measures) || this.queryReferencesSemiAdditiveMeasures()) {
        return this.newQueryWithoutNative().buildSqlAndParams(exportAnnotatedSql);
      }

      // period_average + denominator:data（整区间 / 形态 B）在明细层 COUNT(DISTINCT) 代价过高，
      // 回退到 JS 生成器：先按 avg_unit 预聚合，再在外层用 COUNT 计有数据周期数。
      if (this.shouldUsePeriodAverageDataPreAggregatePath()) {
        return this.newQueryWithoutNative().buildSqlAndParams(exportAnnotatedSql);
      }

      // period_average（含窗口函数 SUM(...) OVER(...)）的 measure filter 在 Tesseract 路径下
      // 会进入 HAVING 子句，而 MySQL/Postgres/达梦/Oracle 均不允许 HAVING 中使用窗口函数
      // （MySQL ERROR 3593）。JS 生成器已通过外层子查询将此类过滤改写为外层 WHERE，
      // 故回退到 JS 生成器以保证正确性。
      if (this.hasPeriodAverageMeasureFilters()) {
        return this.newQueryWithoutNative().buildSqlAndParams(exportAnnotatedSql);
      }

      return this.buildSqlAndParamsRust(exportAnnotatedSql);
    }

    if (!this.options.preAggregationQuery && !this.options.disableExternalPreAggregations && this.externalQueryClass) {
      if (this.externalPreAggregationQuery()) { // TODO performance
        return this.externalQuery().buildSqlAndParams(exportAnnotatedSql);
      }
    }

    return this.compilers.compiler.withQuery(
      this,
      () => this.cacheValue(
        ['buildSqlAndParams', exportAnnotatedSql],
        () => this.paramAllocator.buildSqlAndParams(
          this.buildParamAnnotatedSql(),
          exportAnnotatedSql,
          this.shouldReuseParams
        ),
        { cache: this.queryCache }
      )
    );
  }

  driverTools(external) {
    if (external && !this.options.disableExternalPreAggregations && this.externalQueryClass) {
      return this.externalQuery();
    }
    return this;
  }

  buildSqlAndParamsRust(exportAnnotatedSql) {
    const order = this.options.order && R.pipe(
      R.map((hash) => ((!hash || !hash.id) ? null : hash)),
      R.reject(R.isNil),
    )(this.options.order);
    const queryParams = {
      measures: this.options.measures,
      dimensions: this.options.dimensions,
      segments: this.options.segments,
      timeDimensions: this.options.timeDimensions,
      timezone: this.options.timezone,
      joinGraph: this.joinGraph,
      cubeEvaluator: this.cubeEvaluator,
      securityContext: this.contextSymbols.securityContext,
      order,
      filters: this.options.filters,
      limit: this.options.limit ? this.options.limit.toString() : null,
      rowLimit: this.options.rowLimit ? this.options.rowLimit.toString() : null,
      offset: this.options.offset ? this.options.offset.toString() : null,
      baseTools: this,
      ungrouped: this.options.ungrouped,
      exportAnnotatedSql: exportAnnotatedSql === true,
      preAggregationQuery: this.options.preAggregationQuery,
      preAggregationId: this.options.preAggregationId || null,
      totalQuery: this.options.totalQuery,
      joinHints: this.options.joinHints,
      cubestoreSupportMultistage: this.options.cubestoreSupportMultistage ?? getEnv('cubeStoreRollingWindowJoin'),
      disableExternalPreAggregations: !!this.options.disableExternalPreAggregations,
      convertTzForRawTimeDimension: !!this.options.convertTzForRawTimeDimension,
      maskedMembers: this.options.maskedMembers,
      resultMaskedMembers: this.options.resultMaskedMembers,
      memberToAlias: this.options.memberToAlias,
    };

    try {
      const buildResult = nativeBuildSqlAndParams(queryParams);

      const [query, params, preAggResult] = buildResult;
      const paramsArray = [...params];
      this.applyNativePreAggResult(preAggResult);
      return [query, paramsArray];
    } catch (e) {
      if (e.name === 'TesseractUserError') {
        throw new UserError(e.message);
      }
      throw e;
    }
  }

  // FIXME Temporary solution
  findPreAggregationForQueryRust() {
    let optionsOrder = this.options.order;
    if (optionsOrder && !Array.isArray(optionsOrder)) {
      optionsOrder = [optionsOrder];
    }
    const order = optionsOrder ? R.pipe(
      R.map((hash) => ((!hash || !hash.id) ? null : hash)),
      R.reject(R.isNil),
    )(optionsOrder) : undefined;

    const queryParams = {
      measures: this.options.measures,
      dimensions: this.options.dimensions,
      segments: this.options.segments,
      timeDimensions: this.options.timeDimensions,
      timezone: this.options.timezone,
      joinGraph: this.joinGraph,
      cubeEvaluator: this.cubeEvaluator,
      order,
      filters: this.options.filters,
      limit: this.options.limit ? this.options.limit.toString() : null,
      rowLimit: this.options.rowLimit ? this.options.rowLimit.toString() : null,
      offset: this.options.offset ? this.options.offset.toString() : null,
      baseTools: this,
      ungrouped: this.options.ungrouped,
      exportAnnotatedSql: false,
      preAggregationQuery: this.options.preAggregationQuery,
      preAggregationId: this.options.preAggregationId || null,
      securityContext: this.contextSymbols.securityContext,
      cubestoreSupportMultistage: this.options.cubestoreSupportMultistage ?? getEnv('cubeStoreRollingWindowJoin'),
      disableExternalPreAggregations: !!this.options.disableExternalPreAggregations,
    };

    const buildResult = nativeBuildSqlAndParams(queryParams);

    const [, , preAggResult] = buildResult;
    this.applyNativePreAggResult(preAggResult);
    return this.preAggregations.preAggregationForQuery;
  }

  applyNativePreAggResult(preAggResult) {
    if (!preAggResult) return;
    if (Array.isArray(preAggResult)) {
      this.preAggregations.preAggregationUsageInfos = preAggResult;
      const first = preAggResult[0];
      this.preAggregations.preAggregationForQuery =
        this.getPreAggregationByName(first.cubeName, first.preAggregationName);
    } else {
      this.preAggregations.preAggregationForQuery = preAggResult;
    }
  }

  allCubeMembers(path) {
    const fromPath = this.cubeEvaluator.cubeFromPath(path);

    return Object.keys(fromPath.measures).concat(Object.keys(fromPath.dimensions));
  }

  getAllocatedParams() {
    return this.paramAllocator.getParams();
  }

  // FIXME helper for native generator, maybe should be moved entirely to rust
  generateTimeSeries(granularity, dateRange) {
    return timeSeriesBase(granularity, dateRange, { timestampPrecision: this.timestampPrecision() });
  }

  // FIXME helper for native generator, maybe should be moved entirely to rust
  generateCustomTimeSeries(granularityInterval, dateRange, origin) {
    return timeSeriesFromCustomInterval(granularityInterval, dateRange, moment(origin), { timestampPrecision: this.timestampPrecision() });
  }

  getPreAggregationByName(cube, preAggregationName) {
    return this.preAggregations.getRollupPreAggregationByName(cube, preAggregationName);
  }

  get shouldReuseParams() {
    return false;
  }

  /**
   * Returns a dictionary mapping each preagregation to its corresponding query fragment.
   * @returns {Record<string, Array<string>>}
   */
  buildLambdaQuery() {
    const preAggForQuery = this.preAggregations.findPreAggregationForQuery();
    const result = {};
    if (preAggForQuery && preAggForQuery.preAggregation.unionWithSourceData) {
      const lambdaPreAgg = preAggForQuery.referencedPreAggregations[preAggForQuery.referencedPreAggregations.length - 1];
      // TODO(cristipp) Use source query instead of preaggregation references.
      const references = this.cubeEvaluator.evaluatePreAggregationReferences(lambdaPreAgg.cube, lambdaPreAgg.preAggregation);
      const lambdaQuery = this.newSubQuery(
        {
          measures: references.measures,
          dimensions: references.dimensions,
          timeDimensions: references.timeDimensions,
          filters: [
            ...this.options.filters ?? [],
            references.timeDimensions.length > 0
              ? {
                member: references.timeDimensions[0].dimension,
                operator: 'afterDate',
                values: [FROM_PARTITION_RANGE]
              }
              : [],
          ],
          segments: this.options.segments,
          order: [],
          limit: undefined,
          offset: undefined,
          rowLimit: MAX_SOURCE_ROW_LIMIT,
          preAggregationQuery: true,
        }
      );
      const sqlAndParams = lambdaQuery.buildSqlAndParams();
      const cacheKeyQueries = this.evaluateSymbolSqlWithContext(
        () => this.cacheKeyQueries(),
        { preAggregationQuery: true }
      );
      result[this.preAggregations.preAggregationId(lambdaPreAgg)] = { sqlAndParams, cacheKeyQueries };
    }
    return result;
  }

  externalQuery() {
    const ExternalQuery = this.externalQueryClass;
    return new ExternalQuery(this.compilers, {
      ...this.options,
      externalQueryClass: null
    });
  }

  runningTotalDateJoinCondition() {
    return this.timeDimensions
      .map(
        d => [
          d,
          (_dateFrom, dateTo, dateField, dimensionDateFrom, _dimensionDateTo) => `${dateField} >= ${dimensionDateFrom} AND ${dateField} <= ${dateTo}`
        ]
      );
  }

  rollingWindowToDateJoinCondition(granularity) {
    return Object.values(
      this.timeDimensions.reduce((acc, td) => {
        const key = td.dimension;

        if (!acc[key]) {
          acc[key] = td;
        }

        if (!acc[key].granularity && td.granularity) {
          acc[key] = td;
        }

        return acc;
      }, {})
    ).map(
      d => [
        d,
        (dateFrom, dateTo, dateField, _dimensionDateFrom, _dimensionDateTo, _isFromStartToEnd) => `${dateField} >= ${this.timeGroupedColumn(granularity, dateFrom)} AND ${dateField} <= ${dateTo}`
      ]
    );
  }

  rollingWindowDateJoinCondition(trailingInterval, leadingInterval, offset) {
    offset = offset || 'end';
    return Object.values(
      this.timeDimensions.reduce((acc, td) => {
        const key = td.dimension;

        if (!acc[key]) {
          acc[key] = td;
        }

        if (!acc[key].granularity && td.granularity) {
          acc[key] = td;
        }

        return acc;
      }, {})
    )
      .map(
        d => [d, (dateFrom, dateTo, dateField, _dimensionDateFrom, _dimensionDateTo, isFromStartToEnd) => {
          // dateFrom based window
          const conditions = [];
          if (trailingInterval !== 'unbounded') {
            const startDate = isFromStartToEnd || offset === 'start' ? dateFrom : dateTo;
            const trailingStart = trailingInterval ? this.subtractInterval(startDate, trailingInterval) : startDate;
            const sign = offset === 'start' ? '>=' : '>';
            conditions.push(`${dateField} ${sign} ${trailingStart}`);
          }
          if (leadingInterval !== 'unbounded') {
            const endDate = isFromStartToEnd || offset === 'end' ? dateTo : dateFrom;
            const leadingEnd = leadingInterval ? this.addInterval(endDate, leadingInterval) : endDate;
            const sign = offset === 'end' ? '<=' : '<';
            conditions.push(`${dateField} ${sign} ${leadingEnd}`);
          }
          return conditions.length ? conditions.join(' AND ') : '1 = 1';
        }]
      );
  }

  /**
   * @param {string} date
   * @param {string} interval
   * @returns {string}
   */
  subtractInterval(date, interval) {
    const intervalStr = this.intervalString(interval);
    return `${date} - interval ${intervalStr}`;
  }

  /**
   * @param {string} date
   * @param {string} interval
   * @returns {string}
   */
  addInterval(date, interval) {
    const intervalStr = this.intervalString(interval);
    return `${date} + interval ${intervalStr}`;
  }

  // For use in Tesseract
  supportGeneratedSeriesForCustomTd() {
    return false;
  }

  /**
   * @param {string} interval
   * @returns {string}
   */
  intervalString(interval) {
    return `'${interval}'`;
  }

  /**
   * @param {string} timestamp
   * @param {string} interval
   * @returns {string}
   */
  addTimestampInterval(timestamp, interval) {
    return this.addInterval(timestamp, interval);
  }

  /**
   * @param {string} timestamp
   * @param {string} interval
   * @returns {string}
   */
  subtractTimestampInterval(timestamp, interval) {
    return this.subtractInterval(timestamp, interval);
  }

  cumulativeMeasures() {
    return this.measures.filter(m => m.isCumulative());
  }

  isRolling() {
    return !!this.measures.find(m => m.isRolling()); // TODO
  }

  simpleQuery() {
    if (this.shouldUsePeriodAverageDataPreAggregatePath()) {
      return this.buildPeriodAverageDataQuery();
    }

    // eslint-disable-next-line prefer-template
    const inlineWhereConditions = [];
    const commonQuery = this.rewriteInlineWhere(() => this.commonQuery(), inlineWhereConditions);
    if (this.multiStageQuery) {
      return `${commonQuery} ${this.baseWhere(this.allFilters.concat(inlineWhereConditions))}`;
    }
    const query = `${commonQuery} ${this.baseWhere(this.allFilters.concat(inlineWhereConditions))}` +
      this.groupByClause();
    // period_average（窗口函数）指标的 measure filter 不能进 HAVING
    // （MySQL ERROR 3593 等），改走外层子查询 WHERE。
    if (this.hasPeriodAverageMeasureFilters()) {
      const wrapped = this.wrapWithOuterMeasureFilters(query);
      return wrapped + this.orderBy() + this.groupByDimensionLimit();
    }
    return this.baseHaving(query, this.measureFilters) +
      this.orderBy() +
      this.groupByDimensionLimit();
  }

  /**
   * Returns SQL query string.
   * @returns {string}
   */
  fullKeyQueryAggregate() {
    // Multi-stage CTE layers from renderWithQuery() set disableExternalPreAggregations.
    // When FROM is a prior CTE, semi-additive base measures are already aggregated upstream;
    // re-entering fullKeyQueryAggregateMeasures() would rebuild the same WITH chain and recurse.
    if (
      this.from
      && (
        !this.queryReferencesSemiAdditiveMeasures()
        || this.options.disableExternalPreAggregations
      )
    ) {
      return this.simpleQuery();
    }
    const {
      multipliedMeasures,
      regularMeasures,
      cumulativeMeasures,
      withQueries,
      multiStageMembers,
    } = this.fullKeyQueryAggregateMeasures();

    // 检查是否有半累加指标（含计算指标递归引用到的半累加指标）
    const hasSemiAdditiveMeasures = this.hasSemiAdditiveMeasures(regularMeasures)
      || this.collectReferencedSemiAdditiveMeasures(regularMeasures, this.allFilters).length > 0;

    if (!multipliedMeasures.length && !cumulativeMeasures.length && !multiStageMembers.length && !hasSemiAdditiveMeasures) {
      return this.simpleQuery();
    }

    const renderedWithQueries = withQueries.map(q => this.renderWithQuery(q));

    let toJoin;
    if (this.options.preAggregationQuery) {
      const allRegular = regularMeasures.concat(
        cumulativeMeasures
          .map(
            ([multiplied, measure]) => (multiplied ? null : measure)
          )
          .filter(m => !!m)
      );
      const allMultiplied = multipliedMeasures.concat(
        cumulativeMeasures
          .map(
            ([multiplied, measure]) => (multiplied ? measure : null)
          )
          .filter(m => !!m)
      );
      toJoin = (allRegular.length ? [
        this.withCubeAliasPrefix(
          'main',
          () => this.regularMeasuresSubQuery(allRegular),
        )
      ] : [])
        .concat(
          R.pipe(
            R.groupBy(m => m.cube().name),
            R.toPairs,
            R.map(
              ([keyCubeName, measures]) => this.withCubeAliasPrefix(
                `${keyCubeName}_key`,
                () => this.aggregateSubQuery(keyCubeName, measures),
              )
            )
          )(allMultiplied)
        );
    } else {
      toJoin =
        (regularMeasures.length ? [
          this.withCubeAliasPrefix(
            'main',
            () => this.regularMeasuresSubQuery(regularMeasures),
          ),
        ] : [])
          .concat(
            R.pipe(
              R.groupBy(m => m.cube().name),
              R.toPairs,
              R.map(
                ([keyCubeName, measures]) => this
                  .withCubeAliasPrefix(
                    `${this.aliasName(keyCubeName)}_key`,
                    () => this.aggregateSubQuery(
                      keyCubeName,
                      measures,
                    )
                  )
              )
            )(multipliedMeasures)
          ).concat(
            R.map(
              ([multiplied, measure]) => this.withCubeAliasPrefix(
                `${this.aliasName(measure.measure.replace('.', '_'))
                }_cumulative`,
                () => this.overTimeSeriesQuery(
                  multiplied
                    ? (measures, filters) => this.aggregateSubQuery(
                      measures[0].cube().name,
                      measures,
                      filters,
                    )
                    : this.regularMeasuresSubQuery.bind(this),
                  measure,
                  false,
                ),
              )
            )(cumulativeMeasures)
            // TODO SELECT *
          ).concat(multiStageMembers.map(m => `SELECT * FROM ${m.alias}`));
    }

    // Move regular measures to multiplied ones if there are same
    // cubes to calculate. Most of the time it'll be much faster to
    // calculate as there will be only single scan per cube.
    if (
      regularMeasures.length &&
      multipliedMeasures.length &&
      !cumulativeMeasures.length
    ) {
      const cubeNames = R.pipe(
        R.map(m => m.cube().name),
        R.uniq,
        R.sortBy(R.identity),
      );
      const regularMeasuresCubes = cubeNames(regularMeasures);
      const multipliedMeasuresCubes = cubeNames(multipliedMeasures);
      if (R.equals(regularMeasuresCubes, multipliedMeasuresCubes)) {
        const measuresList = regularMeasures.concat(multipliedMeasures);
        // We need to use original measures sorting to avoid problems
        // with the query order.
        measuresList.sort((m1, m2) => {
          let i1;
          let i2;
          this.measures.forEach((m, i) => {
            if (m.measure === m1.measure) { i1 = i; }
            if (m.measure === m2.measure) { i2 = i; }
          });
          return i1 - i2;
        });
        toJoin = R.pipe(
          R.groupBy(m => m.cube().name),
          R.toPairs,
          R.map(
            ([keyCubeName, measures]) => this.withCubeAliasPrefix(
              `${keyCubeName}_key`,
              () => this.aggregateSubQuery(keyCubeName, measures),
            )
          )
        )(measuresList);
      }
    }

    const multiStageMeasures = R.flatten(multiStageMembers.map(m => m.measures)).map(m => this.newMeasure(m));

    return this.withQueries(this.joinFullKeyQueryAggregate(
      // TODO separate param?
      multipliedMeasures.concat(multiStageMeasures),
      regularMeasures,
      cumulativeMeasures,
      toJoin,
      { multiStageBranchCount: multiStageMembers.length },
    ), renderedWithQueries);
  }

  joinFullKeyQueryAggregate(
    multipliedMeasures,
    regularMeasures,
    cumulativeMeasures,
    toJoin,
    joinOptions = {},
  ) {
    return this.outerMeasuresJoinFullKeyQueryAggregate(
      multipliedMeasures.concat(regularMeasures).concat(cumulativeMeasures.map(([multiplied, measure]) => measure)),
      this.measures,
      toJoin,
      joinOptions,
    );
  }

  outerMeasuresJoinFullKeyQueryAggregate(innerMembers, outerMembers, toJoin, joinOptions = {}) {
    const multiStageBranchCount = joinOptions.multiStageBranchCount ?? 0;
    const renderedReferenceContext = {
      renderedReference: R.pipe(
        R.map(m => {
          const member = m.measure ? m.measure : m.dimension;
          const memberPath = typeof member === 'string'
            ? member
            : this.cubeEvaluator.pathFromArray([m.measure?.originalCubeName ?? m.expressionCubeName, m.expressionName]);
          return [memberPath, m.aliasName()];
        }),
        R.fromPairs,
      )(innerMembers),
    };

    const firstMultiStageBranchIndex =
      multiStageBranchCount > 0 ? toJoin.length - multiStageBranchCount : Number.POSITIVE_INFINITY;

    const join = R.drop(1, toJoin)
      .map(
        (q, i) => {
          const qRightIndex = i + 1;
          if (!this.dimensionAliasNames().length) {
            return `, ${this.wrapInParenthesis(q)} ${this.asSyntaxJoin} q_${qRightIndex}`;
          }
          const useLeftJoinToQ0 =
            multiStageBranchCount > 0 && qRightIndex >= firstMultiStageBranchIndex;
          if (useLeftJoinToQ0) {
            return `LEFT JOIN ${this.wrapInParenthesis((q))} ${this.asSyntaxJoin} q_${qRightIndex} ON ${this.dimensionsJoinCondition('q_0', `q_${qRightIndex}`)}`;
          }
          return `INNER JOIN ${this.wrapInParenthesis((q))} ${this.asSyntaxJoin} q_${qRightIndex} ON ${this.dimensionsJoinCondition(`q_${i}`, `q_${qRightIndex}`)}`;
        },
      ).join('\n');

    const columnsToSelect = this.evaluateSymbolSqlWithContext(
      () => this.dimensionColumns('q_0').concat(outerMembers.map(m => m.selectColumns())).join(', '),
      renderedReferenceContext,
    );

    const queryHasNoRemapping = this.evaluateSymbolSqlWithContext(
      () => this.dimensionsForSelect().concat(outerMembers).every(r => r.hasNoRemapping()),
      renderedReferenceContext,
    );

    const havingFilters = this.evaluateSymbolSqlWithContext(
      () => this.baseWhere(this.measureFilters),
      renderedReferenceContext,
    );

    const prevOrderByJoinAmbiguity = this.orderByJoinAmbiguity;
    this.orderByJoinAmbiguity =
      toJoin.length > 1 && this.dimensionAliasNames().length > 0;

    try {
      // TODO all having filters should be pushed down
      // subQuery dimensions can introduce projection remapping
      if (
        toJoin.length === 1 &&
        this.measureFilters.length === 0 &&
        outerMembers.filter(m => m.expression).length === 0 &&
        queryHasNoRemapping
      ) {
        return `${toJoin[0].replace(/^SELECT/, `SELECT ${this.topLimit()}`)} ${this.orderBy()}${this.groupByDimensionLimit()}`;
      }

      return `SELECT ${this.topLimit()}${columnsToSelect} FROM ${this.wrapInParenthesis(toJoin[0])} ${this.asSyntaxJoin} q_0 ${join}${havingFilters}${this.orderBy()}${this.groupByDimensionLimit()}`;
    } finally {
      this.orderByJoinAmbiguity = prevOrderByJoinAmbiguity;
    }
  }

  wrapInParenthesis(select) {
    return select.trim().match(/^[a-zA-Z0-9_\-`".*]+$/i) ? select : `(${select})`;
  }

  withQueries(select, withQueries) {
    if (!withQueries || !withQueries.length) {
      return select;
    }
    // TODO escape alias
    return `WITH\n${withQueries.map(q => `${q.alias} AS (${q.query})`).join(',\n')}\n${select}`;
  }

  fullKeyQueryAggregateMeasures(context) {
    const measureToHierarchy = this.collectRootMeasureToHierarchy(context);
    const allMemberChildren = this.collectAllMemberChildren(context);
    const memberToIsMultiStage = this.collectAllMultiStageMembers(allMemberChildren);

    const hasMultiStageMembers = (m) => {
      if (memberToIsMultiStage[m]) {
        return true;
      }
      return allMemberChildren[m]?.some(c => hasMultiStageMembers(c)) || false;
    };

    const measuresToRender = (multiplied, cumulative) => R.pipe(
      R.values,
      R.flatten,
      R.filter(
        m => m.multiplied === multiplied && this.newMeasure(m.measure).isCumulative() === cumulative && !hasMultiStageMembers(m.measure)
      ),
      R.map(m => m.measure),
      R.uniq,
      R.map(m => this.newMeasure(m))
    );

    const multipliedMeasures = measuresToRender(true, false)(measureToHierarchy);
    const regularMeasures = measuresToRender(false, false)(measureToHierarchy);
    const cumulativeMeasures =
      R.pipe(
        R.map(multiplied => R.xprod([multiplied], measuresToRender(multiplied, true)(measureToHierarchy))),
        R.unnest
      )([false, true]);
    const withQueries = [];
    const multiStageMembers = R.uniq(
      this.allMembersConcat(false)
        // TODO boolean logic filter support
        .reduce((acc, m) => {
          if (m.isMemberExpression) {
            let refMemberPath;
            this.evaluateSql(m.cube().name, m.definition().sql, {
              sqlResolveFn: (_symbol, cube, prop) => {
                const path = this.cubeEvaluator.pathFromArray([cube, prop]);
                refMemberPath = path;
                // We don't need real SQL here, so just returning something.
                return path;
              }
            });

            if (hasMultiStageMembers(refMemberPath)) {
              acc.push(refMemberPath);
            }
          } else if (m.expressionPath && hasMultiStageMembers(m.expressionPath())) {
            acc.push(m.expressionPath());
          }

          return acc;
        }, [])
    ).map(m => this.multiStageWithQueries(
      m,
      {
        dimensions: this.dimensions.map(d => d.dimension),
        multiStageDimensions: this.dimensions.map(d => d.dimension),
        // TODO accessing timeDimensions directly from options might miss some processing logic
        timeDimensions: this.options.timeDimensions || [],
        multiStageTimeDimensions: (this.options.timeDimensions || []).filter(td => !!td.granularity),
        // TODO accessing filters directly from options might miss some processing logic
        filters: this.options.filters || [],
        segments: this.options.segments || [],
      },
      allMemberChildren,
      withQueries
    ));
    const usedWithQueries = {};
    multiStageMembers.forEach(m => this.collectUsedWithQueries(usedWithQueries, m));

    return {
      multipliedMeasures,
      regularMeasures,
      cumulativeMeasures,
      multiStageMembers,
      withQueries: withQueries.filter(q => usedWithQueries[q.alias])
    };
  }

  collectAllMemberChildren(context) {
    return this.collectFromMembers(
      false,
      (fn) => {
        const memberChildren = {};
        this.evaluateSymbolSqlWithContext(
          fn,
          { ...context, memberChildren },
        );
        return memberChildren;
      },
      context ? ['collectAllMemberChildren', JSON.stringify(context)] : 'collectAllMemberChildren',
    ).reduce((a, b) => ({ ...a, ...b }), {});
  }

  collectAllMultiStageMembers(allMemberChildren) {
    const allMembers = R.uniq(R.flatten(Object.keys(allMemberChildren).map(k => [k].concat(allMemberChildren[k]))));
    return R.fromPairs(allMembers.map(m => {
      // When `m` is coming from `collectAllMemberChildren`, it can contain `granularities.customGranularityName` in path
      // And it would mess up with join hints detection
      const trimmedPath = this
        .cubeEvaluator
        .parsePathAnyType(m)
        .slice(0, 2)
        .join('.');
      return [m, this.memberInstanceByPath(trimmedPath).isMultiStage()];
    }));
  }

  memberInstanceByPath(m) {
    let member;
    if (!member && this.cubeEvaluator.isMeasure(m)) {
      member = this.newMeasure(m);
    }
    if (!member && this.cubeEvaluator.isDimension(m)) {
      member = this.newDimension(m);
    }
    if (!member && this.cubeEvaluator.isSegment(m)) {
      member = this.newSegment(m);
    }
    if (!member) {
      throw new Error(`Can't resolve '${m}'`);
    }
    return member;
  }

  multiStageWithQueries(member, queryContext, memberChildren, withQueries) {
    // TODO calculate based on remove_filter in future
    const wouldNodeApplyFilters = !memberChildren[member];
    let memberFrom = memberChildren[member]
      ?.map(child => this.multiStageWithQueries(child, this.childrenMultiStageContext(member, queryContext), memberChildren, withQueries));
    const unionFromDimensions = memberFrom ? R.uniq(R.flatten(memberFrom.map(f => f.dimensions))) : queryContext.dimensions;
    const unionDimensionsContext = { ...queryContext, dimensions: unionFromDimensions.filter(d => !this.newDimension(d).isMultiStage()) };
    // TODO is calling multiStageWithQueries twice optimal?
    memberFrom = memberChildren[member] &&
      R.uniqBy(
        f => f.alias,
        memberChildren[member].map(child => this.multiStageWithQueries(child, this.childrenMultiStageContext(member, unionDimensionsContext), memberChildren, withQueries))
      );
    const selfContext = this.selfMultiStageContext(member, queryContext, wouldNodeApplyFilters);
    const subQuery = {
      ...selfContext,
      ...(this.cubeEvaluator.isMeasure(member) ? { measures: [member] } : { measures: [], dimensions: R.uniq(selfContext.dimensions.concat(member)) }),
      memberFrom,
    };

    const foundWith = withQueries.find(({ alias, ...q }) => R.equals(subQuery, q));

    if (foundWith) {
      return foundWith;
    }

    subQuery.alias = `cte_${withQueries.length}`;

    withQueries.push(subQuery);

    return subQuery;
  }

  collectUsedWithQueries(usedQueries, member) {
    usedQueries[member.alias] = true;
    member.memberFrom?.forEach(m => this.collectUsedWithQueries(usedQueries, m));
  }

  childrenMultiStageContext(memberPath, queryContext) {
    let member;
    if (this.cubeEvaluator.isMeasure(memberPath)) {
      member = this.newMeasure(memberPath);
    } else if (this.cubeEvaluator.isDimension(memberPath)) {
      member = this.newDimension(memberPath);
    }
    const memberDef = member.definition();
    // TODO can addGroupBy replaced by something else?
    if (memberDef.addGroupByReferences) {
      const dims = memberDef.addGroupByReferences.reduce((acc, cur) => {
        const pathArr = cur.split('.');
        // addGroupBy may include time dimension with granularity
        // But we don't need it as time dimension
        if (pathArr.length > 2) {
          pathArr.splice(2, 0, 'granularities');
          acc.push(pathArr.join('.'));
        } else {
          acc.push(cur);
        }
        return acc;
      }, []);
      queryContext = {
        ...queryContext,
        dimensions: R.uniq(queryContext.dimensions.concat(dims)),
      };
    }
    if (memberDef.timeShiftReferences?.length) {
      let { commonTimeShift } = queryContext;
      const timeShifts = queryContext.timeShifts || {};
      const memberOfCube = !this.cubeEvaluator.cubeFromPath(memberPath).isView;

      if (memberDef.timeShiftReferences.length === 1 && !memberDef.timeShiftReferences[0].timeDimension) {
        const timeShift = memberDef.timeShiftReferences[0];
        // We avoid view's timeshift evaluation as there will be another round of underlying cube's member evaluation
        if (memberOfCube) {
          commonTimeShift = timeShift.type === 'next' ? this.negateInterval(timeShift.interval) : timeShift.interval;
        }
      } else if (memberOfCube) {
        // We avoid view's timeshift evaluation as there will be another round of underlying cube's member evaluation
        memberDef.timeShiftReferences.forEach((r) => {
          timeShifts[r.timeDimension] = r.type === 'next' ? this.negateInterval(r.interval) : r.interval;
        });
      }

      queryContext = {
        ...queryContext,
        commonTimeShift,
        timeShifts,
      };
    }
    queryContext = {
      ...queryContext,
      // TODO can't remove filters from OR expression
      filters: this.keepFilters(queryContext.filters, filterMember => filterMember !== memberPath),
    };
    return queryContext;
  }

  selfMultiStageContext(memberPath, queryContext, wouldNodeApplyFilters) {
    let member;
    if (this.cubeEvaluator.isMeasure(memberPath)) {
      member = this.newMeasure(memberPath);
    } else if (this.cubeEvaluator.isDimension(memberPath)) {
      member = this.newDimension(memberPath);
      // TODO is it right place to replace context?
      // if (member.definition().type === 'rank') {
      //   queryContext = unionDimensionsContext;
      // }
    }
    const memberDef = member.definition();
    if (memberDef.reduceByReferences) {
      queryContext = {
        ...queryContext,
        multiStageDimensions: R.difference(queryContext.multiStageDimensions, memberDef.reduceByReferences),
        multiStageTimeDimensions: queryContext.multiStageTimeDimensions.filter(td => memberDef.reduceByReferences.indexOf(td.dimension) === -1),
        // dimensions: R.uniq(queryContext.dimensions.concat(memberDef.reduceByReferences))
      };
    }
    if (memberDef.groupByReferences) {
      queryContext = {
        ...queryContext,
        multiStageDimensions: R.intersection(queryContext.multiStageDimensions, memberDef.groupByReferences),
        multiStageTimeDimensions: queryContext.multiStageTimeDimensions.filter(td => memberDef.groupByReferences.indexOf(td.dimension) !== -1),
      };
    }
    if (!wouldNodeApplyFilters) {
      queryContext = {
        ...queryContext,
        // TODO make it same way as keepFilters
        timeDimensions: queryContext.timeDimensions.map(td => ({ ...td, dateRange: undefined })),
        // TODO keep segments related to this multistage (if applicable)
        segments: [],
        filters: this.keepFilters(queryContext.filters, filterMember => filterMember === memberPath),
      };
    } else {
      queryContext = {
        ...queryContext,
        // TODO remove not related segments
        // segments: queryContext.segments,
        filters: this.keepFilters(queryContext.filters, filterMember => !this.memberInstanceByPath(filterMember).isMultiStage()),
      };
    }
    return queryContext;
  }

  renderWithQuery(withQuery) {
    const fromMeasures = withQuery.memberFrom && R.uniq(R.flatten(withQuery.memberFrom.map(f => f.measures)));
    // TODO get rid of this multiStage filter
    const fromDimensions = withQuery.memberFrom && R.uniq(R.flatten(withQuery.memberFrom.map(f => f.dimensions)));
    const fromTimeDimensions = withQuery.memberFrom && R.uniq(R.flatten(withQuery.memberFrom.map(f => (f.timeDimensions || []).map(td => ({ ...td, dateRange: undefined })))));
    const renderedReferenceContext = {
      renderedReference: withQuery.memberFrom && R.fromPairs(
        R.unnest(withQuery.memberFrom.map(from => from.measures.map(m => {
          const measure = this.newMeasure(m);
          return [m, measure.aliasName()];
        }).concat(from.dimensions.map(m => {
          const member = this.newDimension(m);
          // In case of request coming from the SQL API, member could be expression-based
          const mPath = typeof m === 'string' ? m : this.cubeEvaluator.pathFromArray([m.cubeName, m.name]);
          return [mPath, member.aliasName()];
        })).concat(from.timeDimensions.map(m => {
          const member = this.newTimeDimension(m);
          return member.granularity ? [`${member.dimension}.${member.granularity}`, member.aliasName()] : [];
        }))))
      ),
      commonTimeShift: withQuery.commonTimeShift,
      timeShifts: withQuery.timeShifts,
    };

    const fromSubQuery = fromMeasures && this.newSubQuery({
      measures: fromMeasures,
      // TODO get rid of this multiStage filter
      dimensions: fromDimensions, // .filter(d => !this.newDimension(d).isMultiStage()),
      timeDimensions: fromTimeDimensions,
      multiStageDimensions: withQuery.multiStageDimensions,
      multiStageTimeDimensions: withQuery.multiStageTimeDimensions,
      filters: withQuery.filters,
      // TODO do we need it?
      multiStageQuery: true, // !!fromDimensions.find(d => this.newDimension(d).isMultiStage())
      disableExternalPreAggregations: true,
    });

    const measures = fromSubQuery && fromMeasures.map(m => fromSubQuery.newMeasure(m));
    // TODO get rid of this multiStage filter
    const multiStageDimensions = fromSubQuery && fromDimensions.map(m => fromSubQuery.newDimension(m)).filter(d => d.isMultiStage());
    const multiStageTimeDimensions = fromSubQuery && fromTimeDimensions.map(m => fromSubQuery.newTimeDimension(m)).filter(d => d.isMultiStage());
    // TODO not working yet
    const membersToSelect = measures?.concat(multiStageDimensions).concat(multiStageTimeDimensions);
    const select = fromSubQuery && fromSubQuery.outerMeasuresJoinFullKeyQueryAggregate(
      membersToSelect,
      membersToSelect,
      withQuery.memberFrom.map(f => f.alias),
      { multiStageBranchCount: withQuery.memberFrom?.length ?? 0 },
    );
    const fromSql = select && this.wrapInParenthesis(select);

    // When memberFrom only has dimensions (no measures), the previous CTE cannot supply
    // the base table rows needed to compute this stage's measures. Use base table as FROM
    // instead to avoid "missing FROM clause item" when measures reference the cube table.
    // Semi-additive (nonAdditiveDimension) measures must aggregate from raw rows (MIN/MAX of ordering
    // dimension per partition); a prior CTE that only has pre-aggregated sums is wrong. Force base table.
    const stageHasSemiAdditiveMeasure =
      withQuery.measures &&
      withQuery.measures.length > 0 &&
      withQuery.measures.some((measurePath) => {
        try {
          const bm = this.newMeasure(measurePath);
          return typeof bm.isSemiAdditive === 'function' && bm.isSemiAdditive();
        } catch (e) {
          return false;
        }
      });
    // Multi-stage measures with schema-level filters (e.g. subject = '语文') must aggregate
    // from base-table rows. A prior CTE only has pre-aggregated measure columns, so filter
    // dimensions like subject are not in scope and Postgres reports "missing FROM clause item".
    const stageHasMeasureDefinitionFilters =
      withQuery.measures &&
      withQuery.measures.length > 0 &&
      withQuery.measures.some((measurePath) => {
        try {
          const bm = this.newMeasure(measurePath);
          const def = bm.definition();
          return def.filters?.length > 0;
        } catch (e) {
          return false;
        }
      });
    const useFromSubQuery =
      fromSql &&
      fromMeasures &&
      fromMeasures.length > 0 &&
      !stageHasSemiAdditiveMeasure &&
      !stageHasMeasureDefinitionFilters;
    // When querying from base table, do not remap dimensions to previous CTE aliases
    // (e.g. score__subject); use actual column refs (e.g. "score".subject) so the SQL is valid.
    const effectiveRenderedReference = useFromSubQuery ? renderedReferenceContext.renderedReference : undefined;

    if (stageHasMeasureDefinitionFilters) {
      const measures = withQuery.measures.map((m) => this.newMeasure(m));
      return {
        query: this.evaluateSymbolSqlWithContext(
          () => this.regularMeasuresSubQuery(measures),
          {
            ...renderedReferenceContext,
            renderedReference: undefined,
          },
        ),
        alias: withQuery.alias,
      };
    }

    const subQueryOptions = {
      measures: withQuery.measures,
      dimensions: withQuery.dimensions,
      timeDimensions: withQuery.timeDimensions,
      multiStageDimensions: withQuery.multiStageDimensions,
      multiStageTimeDimensions: withQuery.multiStageTimeDimensions,
      filters: withQuery.filters,
      segments: withQuery.segments,
      from: useFromSubQuery && {
        sql: fromSql,
        alias: `${withQuery.alias}_join`,
      },
      // TODO condition should something else instead of rank
      multiStageQuery: !!withQuery.measures.find(d => {
        const { type } = this.newMeasure(d).definition();
        return type === 'rank' || CubeSymbols.isCalculatedMeasureType(type);
      }),
      disableExternalPreAggregations: true,
    };
    const subQuery = this.newSubQuery(subQueryOptions);

    if (!subQuery.from) {
      // `subQuery.from` indicates using a previous-stage CTE as FROM. It's not the same as
      // having no FROM clause at all: regular join-tree queries will still render FROM <cube>.
      // Guard only the truly invalid case where the generated query has no FROM clause.
      const renderedSubQueryFrom = (() => {
        try {
          return subQuery.query();
        } catch (e) {
          return null;
        }
      })();
      const hasFromClause = typeof renderedSubQueryFrom === 'string' && /\bfrom\b/i.test(renderedSubQueryFrom);
      if (!hasFromClause) {
        const allSubQueryMembers = R.flatten(subQuery.collectFromMembers(false, subQuery.collectMemberNamesFor.bind(subQuery), 'collectMemberNamesFor'));
        const multiStageMember = allSubQueryMembers.find(m => this.memberInstanceByPath(m).isMultiStage());
        if (multiStageMember) {
          throw new Error(`Multi stage member '${multiStageMember}' lacks FROM clause in sub query: ${JSON.stringify(subQueryOptions)}`);
        }
      }
    }

    const contextForSubQuery = {
      ...renderedReferenceContext,
      renderedReference: effectiveRenderedReference,
    };
    return {
      query: subQuery.evaluateSymbolSqlWithContext(
        () => subQuery.buildParamAnnotatedSql(),
        contextForSubQuery,
      ),
      alias: withQuery.alias
    };
  }

  dimensionsJoinCondition(leftAlias, rightAlias) {
    const dimensionAliases = this.dimensionAliasNames();
    if (!dimensionAliases.length) {
      return '1 = 1';
    }
    return dimensionAliases
      .map(alias => `(${leftAlias}.${alias} = ${rightAlias}.${alias} OR (${leftAlias}.${alias} IS NULL AND ${rightAlias}.${alias} IS NULL))`)
      .join(' AND ');
  }

  baseWhere(filters) {
    const filterClause = filters.map(t => t.filterToWhere()).filter(R.identity).map(f => `(${f})`);
    return filterClause.length ? ` WHERE ${filterClause.join(' AND ')}` : '';
  }

  baseHaving(query, filters) {
    const filterClause = filters.map(t => t.filterToWhere()).filter(R.identity).map(f => `(${f})`);
    return filterClause.length ? query + ` HAVING ${filterClause.join(' AND ')}` : query;
  }

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
  }

  /**
   * 根据 filter.measure 路径在 this.measures 中查找对应的 measure 对象。
   * @param {{ measure?: string }} filter
   * @returns {BaseMeasure|undefined}
   */
  findMeasureForFilter(filter) {
    const target = filter && filter.measure;
    if (!target) {
      return undefined;
    }
    return this.measures.find(
      (m) => m.measure === target || m.expressionName === target
    );
  }

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
  }

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
  }

  timeStampInClientTz(dateParam) {
    return this.convertTz(dateParam);
  }

  granularityHierarchies() {
    return this.cacheValue(
      // If time dimension custom granularity in data model is defined without
      // timezone information they are treated in query timezone.
      // Because of that it's not possible to correctly precalculate
      // granularities hierarchies on startup as they are specific for each timezone.
      ['granularityHierarchies', this.timezone],
      () => {
        // Mutating a single accumulator object instead of repeatedly spreading
        // it keeps this O(n) in the number of dimensions/granularities. The
        // previous `{ ...acc, ... }` approach copied the whole accumulator on
        // every iteration, making it O(n^2) and extremely slow on large models.
        const hierarchies = {};
        const standardGranularityNames = R.keys(standardGranularitiesParents);

        for (const cube of R.keys(this.cubeEvaluator.evaluatedCubes)) {
          const timeDimensions = this.cubeEvaluator.timeDimensionsForCube(cube);

          for (const tdName of Object.keys(timeDimensions)) {
            const td = timeDimensions[tdName];
            const dimensionKey = `${cube}.${tdName}`;

            // constructing standard granularities for time dimension
            for (const gr of standardGranularityNames) {
              hierarchies[`${dimensionKey}.${gr}`] = standardGranularitiesParents[gr];
            }

            // If we have custom granularities in time dimension
            if (td.granularities) {
              for (const granularityName of Object.keys(td.granularities)) {
                const grObj = new Granularity(this, { dimension: dimensionKey, granularity: granularityName });
                hierarchies[`${dimensionKey}.${granularityName}`] = [
                  granularityName,
                  ...standardGranularitiesParents[grObj.minGranularity()],
                ];
              }
            }
          }
        }

        return hierarchies;
      },
    );
  }

  granularityParentHierarchy(granularity) {
    return standardGranularitiesParents[granularity];
  }

  minGranularity(granularityA, granularityB) {
    if (!granularityA) {
      return granularityB;
    }
    if (!granularityB) {
      return granularityA;
    }
    if (granularityA === granularityB) {
      return granularityA;
    }
    const aHierarchy = R.reverse(this.granularityParentHierarchy(granularityA));
    const bHierarchy = R.reverse(this.granularityParentHierarchy(granularityB));
    let lastIndex = Math.max(
      aHierarchy.findIndex((g, i) => g !== bHierarchy[i]),
      bHierarchy.findIndex((g, i) => g !== aHierarchy[i])
    );
    if (lastIndex === -1 && aHierarchy.length === bHierarchy.length) {
      lastIndex = aHierarchy.length - 1;
    }
    if (lastIndex <= 0) {
      throw new Error(`Can't find common parent for '${granularityA}' and '${granularityB}'`);
    }
    return aHierarchy[lastIndex - 1];
  }

  overTimeSeriesQuery(baseQueryFn, cumulativeMeasure, fromRollup) {
    const dateJoinCondition = cumulativeMeasure.dateJoinCondition();
    const uniqDateJoinCondition = R.uniqBy(djc => djc[0].dimension, dateJoinCondition);
    const cumulativeMeasures = [cumulativeMeasure];
    if (!this.timeDimensions.find(d => d.granularity)) {
      const filters = this.segments
        .concat(this.filters)
        .concat(this.dateFromStartToEndConditionSql(
          // If the same time dimension is passed more than once, no need to build the same
          // filter condition again and again. Different granularities don't play role here,
          // as rollingWindow.granularity is used for filtering.
          uniqDateJoinCondition,
          fromRollup,
          false
        ));
      return baseQueryFn(cumulativeMeasures, filters, false);
    }

    if (this.timeDimensions.filter(d => !d.dateRange && d.granularity).length > 0) {
      throw new UserError('Time series queries without dateRange aren\'t supported');
    }

    // We can't do meaningful query if few time dimensions with different ranges passed,
    // it won't be possible to join them together without losing some rows.
    const rangedTimeDimensions = this.timeDimensions.filter(d => d.dateRange && d.granularity);
    const uniqTimeDimensionWithRanges = R.uniqBy(d => d.dateRange, rangedTimeDimensions);
    if (uniqTimeDimensionWithRanges.length > 1) {
      throw new Error('Can\'t build query for time dimensions with different date ranges');
    }

    // We need to generate time series table for the lowest granularity among all time dimensions
    const [dateSeriesDimension, dateSeriesGranularity] = this.timeDimensions.filter(d => d.granularity)
      .reduce(([prevDim, prevGran], d) => {
        const mg = this.minGranularity(prevGran, d.resolvedGranularity());
        if (mg === d.resolvedGranularity()) {
          return [d, mg];
        }
        return [prevDim, mg];
      }, [null, null]);

    const dateSeriesSql = this.dateSeriesSql(dateSeriesDimension);

    // If the same time dimension is passed more than once, no need to build the same
    // filter condition again and again. Different granularities don't play role here,
    // as rollingWindow.granularity is used for filtering.
    const filters = this.segments
      .concat(this.filters)
      .concat(this.dateFromStartToEndConditionSql(
        uniqDateJoinCondition,
        fromRollup,
        true
      ));
    const baseQuery = this.groupedUngroupedSelect(
      () => baseQueryFn(cumulativeMeasures, filters),
      cumulativeMeasure.shouldUngroupForCumulative(),
      !cumulativeMeasure.shouldUngroupForCumulative() && this.minGranularity(
        cumulativeMeasure.windowGranularity(),
        dateSeriesGranularity
      ) || undefined
    );
    const baseQueryAlias = this.cubeAlias('base');
    const dateJoinConditionSql =
      dateJoinCondition.map(
        ([d, f]) => f(
          // Time-series table is generated differently in different dialects,
          // but some dialects (like BigQuery) require strict date types and can not automatically convert
          // between date and timestamp for comparisons, at the same time, time dimensions are expected to be
          // timestamps, so we need to align types for join conditions/comparisons.
          // But we can't do it here, as it would break interval maths used in some types of
          // rolling window join conditions in some dialects (like Redshift), so we need to
          // do casts granularly in rolling window join conditions functions.
          `${d.dateSeriesAliasName()}.${this.escapeColumnName('date_from')}`,
          `${d.dateSeriesAliasName()}.${this.escapeColumnName('date_to')}`,
          `${baseQueryAlias}.${d.aliasName()}`,
          `'${d.dateFromFormatted()}'`,
          `'${d.dateToFormatted()}'`
        )
      ).join(' AND ');

    return this.overTimeSeriesSelect(
      cumulativeMeasures,
      dateSeriesSql,
      baseQuery,
      dateJoinConditionSql,
      baseQueryAlias,
      dateSeriesDimension.granularity,
    );
  }

  overTimeSeriesSelect(cumulativeMeasures, dateSeriesSql, baseQuery, dateJoinConditionSql, baseQueryAlias, dateSeriesGranularity) {
    const forSelect = this.overTimeSeriesForSelect(cumulativeMeasures, dateSeriesGranularity);
    return `SELECT ${forSelect} FROM ${dateSeriesSql}` +
      ` LEFT JOIN (${baseQuery}) ${this.asSyntaxJoin} ${baseQueryAlias} ON ${dateJoinConditionSql}` +
      this.groupByClause();
  }

  overTimeSeriesForSelect(cumulativeMeasures, dateSeriesGranularity) {
    return this.dimensions
      .map(s => s.cumulativeSelectColumns())
      .concat(this.timeDimensions.map(d => d.dateSeriesSelectColumn(null, dateSeriesGranularity)))
      .concat(cumulativeMeasures.map(s => s.cumulativeSelectColumns()))
      .filter(c => !!c)
      .join(', ');
  }

  /**
   * BigQuery has strict date type and can not automatically convert between date
   * and timestamp, so we override dateFromStartToEndConditionSql() in BigQuery Dialect
   * @protected
   */
  dateFromStartToEndConditionSql(dateJoinCondition, fromRollup, isFromStartToEnd) {
    return dateJoinCondition.map(
      // TODO Consider adding strict definitions of local and UTC time type
      ([d, f]) => ({
        filterToWhere: () => {
          const timeSeries = d.timeSeries();
          return f(
            isFromStartToEnd ?
              this.dateTimeCast(this.paramAllocator.allocateParam(timeSeries[0][0])) :
              `${this.timeStampInClientTz(d.dateFromParam())}`,
            isFromStartToEnd ?
              this.dateTimeCast(this.paramAllocator.allocateParam(timeSeries[timeSeries.length - 1][1])) :
              `${this.timeStampInClientTz(d.dateToParam())}`,
            `${fromRollup ? this.dimensionSql(d) : d.convertedToTz()}`,
            `${this.timeStampInClientTz(d.dateFromParam())}`,
            `${this.timeStampInClientTz(d.dateToParam())}`,
            isFromStartToEnd
          );
        }
      })
    );
  }

  /**
   * @param {import('./BaseTimeDimension').BaseTimeDimension} timeDimension
   * @return {string}
   */
  dateSeriesSql(timeDimension) {
    return `(${this.seriesSql(timeDimension)}) ${this.asSyntaxTable} ${timeDimension.dateSeriesAliasName()}`;
  }

  /**
   * BigQuery has strict date type and can not automatically convert between date
   * and timestamp, so we override seriesSql() in BigQuery Dialect
   * @param {import('./BaseTimeDimension').BaseTimeDimension} timeDimension
   * @return {string}
   */
  seriesSql(timeDimension) {
    const values = timeDimension.timeSeries().map(
      ([from, to]) => `('${from}', '${to}')`
    );
    return `SELECT ${this.dateTimeCast('date_from')} as ${this.escapeColumnName('date_from')}, ${this.dateTimeCast('date_to')} as ${this.escapeColumnName('date_to')} FROM (VALUES ${values}) ${this.asSyntaxTable} dates (date_from, date_to)`;
  }

  /**
   * @param {import('./BaseDimension').BaseDimension|import('./BaseTimeDimension').BaseTimeDimension} timeDimension
   * @return {string}
   */
  timeStampParam(timeDimension) {
    return timeDimension.dateFieldType() === 'string' ? '?' : this.timeStampCast('?');
  }

  timeRangeFilter(dimensionSql, fromTimeStampParam, toTimeStampParam) {
    return `${dimensionSql} >= ${fromTimeStampParam} AND ${dimensionSql} <= ${toTimeStampParam}`;
  }

  timeNotInRangeFilter(dimensionSql, fromTimeStampParam, toTimeStampParam) {
    return `${dimensionSql} < ${fromTimeStampParam} OR ${dimensionSql} > ${toTimeStampParam}`;
  }

  beforeDateFilter(dimensionSql, timeStampParam) {
    return `${dimensionSql} < ${timeStampParam}`;
  }

  beforeOrOnDateFilter(dimensionSql, timeStampParam) {
    return `${dimensionSql} <= ${timeStampParam}`;
  }

  afterDateFilter(dimensionSql, timeStampParam) {
    return `${dimensionSql} > ${timeStampParam}`;
  }

  afterOrOnDateFilter(dimensionSql, timeStampParam) {
    return `${dimensionSql} >= ${timeStampParam}`;
  }

  timeStampCast(value) {
    return `${value}::timestamptz`;
  }

  dateTimeCast(value) {
    return `${value}::timestamp`;
  }

  /**
   * Converts the input interval (e.g. "2 years", "3 months", "5 days")
   * into a format compatible with the target SQL dialect.
   * Also returns the minimal time unit required (e.g. for use in DATEDIFF).
   *
   * Returns a tuple: (formatted interval, minimal time unit)
   */
  intervalAndMinimalTimeUnit(interval) {
    const minGranularity = this.diffTimeUnitForInterval(interval);
    return [interval, minGranularity];
  }

  commonQuery() {
    return `SELECT${this.topLimit()}
      ${this.baseSelect()}
    FROM
      ${this.query()}`;
  }

  dimensionOnlyMeasureToHierarchy(context, m) {
    const measureName = typeof m.measure === 'string' ? m.measure : `${m.measure.cubeName}.${m.measure.name}`;
    const memberNamesForMeasure = this.collectFrom(
      [m],
      this.collectMemberNamesFor.bind(this),
      context ? ['collectMemberNamesFor', JSON.stringify(context)] : 'collectMemberNamesFor',
      this.queryCache
    );
    const cubeNamesForMeasure = R.pipe(
      R.map(member => this.memberInstanceByPath(member)),
      // collectMemberNamesFor can return both view.dim and cube.dim
      R.filter(member => member.definition().ownedByCube),
      R.map(member => member.cube().name),
      // Single member expression can reference multiple dimensions from same cube
      R.uniq,
    )(
      memberNamesForMeasure
    );

    let cubeNameToAttach;
    switch (cubeNamesForMeasure.length) {
      case 0:
        // For zero reference measure there's nothing to derive info about measure from
        // So it assume that it's a regular measure, and it will be evaluated on top of join tree
        return [measureName, [{
          multiplied: false,
          measure: m.measure,
        }]];
      case 1:
        [cubeNameToAttach] = cubeNamesForMeasure;
        break;
      default:
        throw new Error(`Expected single cube for dimension-only measure ${measureName}, got ${cubeNamesForMeasure}`);
    }

    const multiplied = this.multipliedJoinRowResult(cubeNameToAttach) || false;

    const attachedMeasure = {
      ...m.measure,
      originalCubeName: m.measure.cubeName,
      cubeName: cubeNameToAttach
    };

    return [measureName, [{
      multiplied,
      measure: attachedMeasure,
    }]];
  }

  collectRootMeasureToHierarchy(context) {
    const notAddedMeasureFilters = R.flatten(this.measureFilters.map(f => f.getMembers()))
      .filter(f => R.none(m => m.measure === f.measure, this.measures));

    return R.fromPairs(this.measures.concat(notAddedMeasureFilters).map(m => {
      const collectedMeasures = this.collectFrom(
        [m],
        this.collectMultipliedMeasures(context),
        context ? ['collectMultipliedMeasures', JSON.stringify(context)] : 'collectMultipliedMeasures',
        this.queryCache
      );
      if (m.expressionName && !collectedMeasures.length && !m.isMemberExpression) {
        throw new UserError(`Subquery measure ${m.expressionName} should reference at least one member`);
      }

      if (collectedMeasures.length === 0 && m.isMemberExpression) {
        // `m` is member expression measure, but does not reference any other measure
        // Consider this dimensions-only measure. This can happen at least in 2 cases:
        // 1. Ad-hoc aggregation over dimension: SELECT MAX(dim) FROM cube
        // 2. Ungrouped query with SQL pushdown will render every column as measure: SELECT dim1 FROM cube WHERE LOWER(dim2) = 'foo';
        // Measures like this needs a special treatment to attach them to cube and decide if they are multiplied or not
        // This would return measure object in `measure`, not path
        // TODO return measure object for every measure
        return this.dimensionOnlyMeasureToHierarchy(context, m);
      }

      let measureKey;
      if (typeof m.measure === 'string') {
        measureKey = m.measure;
      } else if (m.isMemberExpression) {
        // TODO expressionName vs definition?
        measureKey = m.expressionName;
      } else {
        measureKey = `${m.measure.cubeName}.${m.measure.name}`;
      }
      return [measureKey, collectedMeasures];
    }));
  }

  query() {
    return this.from && this.joinSql([this.from]) || this.joinQuery(this.join, this.collectFromMembers(
      false,
      this.collectSubQueryDimensionsFor.bind(this),
      'collectSubQueryDimensionsFor'
    ));
  }

  /**
   *
   * @param {string} cube
   * @param {boolean} [isLeftJoinCondition]
   * @returns {[string, string, string?]}
   */
  rewriteInlineCubeSql(cube, isLeftJoinCondition) {
    const sql = this.cubeSql(cube);
    const cubeAlias = this.cubeAlias(cube);
    if (
      this.cubeEvaluator.cubeFromPath(cube).rewriteQueries
    ) {
      // TODO params independent sql caching
      const parser = this.queryCache.cache(['SqlParser', sql], () => new SqlParser(sql));
      if (parser.isSimpleAsteriskQuery()) {
        const conditions = parser.extractWhereConditions(cubeAlias);
        if (!isLeftJoinCondition && this.safeEvaluateSymbolContext().inlineWhereConditions) {
          this.safeEvaluateSymbolContext().inlineWhereConditions.push({ filterToWhere: () => conditions });
        }
        return [parser.extractTableFrom(), cubeAlias, conditions];
      } else {
        return [sql, cubeAlias];
      }
    } else {
      return [sql, cubeAlias];
    }
  }

  /**
   * @param {import('../compiler/JoinGraph').FinishedJoinTree} join
   * @param {Array<string>} subQueryDimensions
   * @returns {string}
   */
  joinQuery(join, subQueryDimensions) {
    const subQueryDimensionsByCube = R.groupBy(d => this.cubeEvaluator.cubeNameFromPath(d), subQueryDimensions);
    const joins = join.joins.flatMap(
      j => {
        const [cubeSql, cubeAlias, conditions] = this.rewriteInlineCubeSql(j.originalTo, true);
        return [{
          sql: cubeSql,
          alias: cubeAlias,
          on: `${this.evaluateSql(j.originalFrom, j.join.sql)}${conditions ? ` AND (${conditions})` : ''}`
          // TODO handle the case when sub query referenced by a foreign cube on other side of a join
        }].concat((subQueryDimensionsByCube[j.originalTo] || []).map(d => this.subQueryJoin(d)));
      }
    );

    const [cubeSql, cubeAlias] = this.rewriteInlineCubeSql(join.root);

    return this.joinSql([
      { sql: cubeSql, alias: cubeAlias },
      ...(subQueryDimensionsByCube[join.root] || []).map(d => this.subQueryJoin(d)),
      ...joins,
      ...this.customSubQueryJoins.map((customJoin) => this.customSubQueryJoin(customJoin)),
    ]);
  }

  /**
   * @param {JoinChain} toJoin
   * @returns {string}
   */
  joinSql(toJoin) {
    const [root, ...rest] = toJoin;
    const joins = rest.map(
      j => {
        const joinType = j.joinType ?? 'LEFT';
        return `${joinType} JOIN ${j.sql} ${this.asSyntaxJoin} ${j.alias} ON ${j.on}`;
      }
    );

    return [`${root.sql} ${this.asSyntaxJoin} ${root.alias}`, ...joins].join('\n');
  }

  /**
   *
   * @param {{sql: string, on: {cubeName: string, expression: Function}, joinType: 'LEFT' | 'INNER', alias: string}}
   *   customJoin
   * @returns {JoinItem}
   */
  customSubQueryJoin(customJoin) {
    const on = this.evaluateSql(customJoin.on.cubeName, customJoin.on.expression);

    return {
      sql: `(${customJoin.sql})`,
      alias: customJoin.alias,
      on,
      joinType: customJoin.joinType,
    };
  }

  /**
   *
   * @param {string} dimension
   * @returns {JoinItem}
   */
  subQueryJoin(dimension) {
    const { prefix, subQuery, cubeName } = this.subQueryDescription(dimension);
    const primaryKeys = this.cubeEvaluator.primaryKeys[cubeName];
    const subQueryAlias = this.escapeColumnName(this.aliasName(prefix));

    const { collectOriginalSqlPreAggregations } = this.safeEvaluateSymbolContext();
    const sql = subQuery.evaluateSymbolSqlWithContext(() => subQuery.buildParamAnnotatedSql(), {
      collectOriginalSqlPreAggregations
    });
    const onCondition = primaryKeys.map((pk) => `${subQueryAlias}.${this.newDimension(this.primaryKeyName(cubeName, pk)).aliasName()} = ${this.primaryKeySql(pk, cubeName)}`);

    return {
      sql: `(${sql})`,
      alias: subQueryAlias,
      on: onCondition.join(' AND ')
    };
  }

  get filtersWithoutSubQueries() {
    if (!this.filtersWithoutSubQueriesValue) {
      this.filtersWithoutSubQueriesValue = this.allFilters.filter(
        f => this.collectFrom([f], this.collectSubQueryDimensionsFor.bind(this), 'collectSubQueryDimensionsFor').length === 0
      );
    }
    return this.filtersWithoutSubQueriesValue;
  }

  /**
   *
   * @param {string} dimension
   * @returns {{ prefix: string, subQuery: this, cubeName: string }}
   */
  subQueryDescription(dimension) {
    const symbol = this.cubeEvaluator.dimensionByPath(dimension);
    const [cubeName, name] = this.cubeEvaluator.parsePath('dimensions', dimension);
    const prefix = this.subQueryName(cubeName, name);
    let filters;
    let segments;
    let timeDimensions;
    if (symbol.propagateFiltersToSubQuery) {
      filters = this.filtersWithoutSubQueries.filter(
        f => f instanceof BaseFilter && !(f instanceof BaseTimeDimension)
      ).map(f => ({
        dimension: f.dimension,
        operator: f.operator,
        values: f.values
      }));

      timeDimensions = this.filtersWithoutSubQueries.filter(
        f => f instanceof BaseTimeDimension
      ).map(f => ({
        dimension: f.dimension,
        dateRange: f.dateRange
      }));

      segments = this.filtersWithoutSubQueries.filter(
        f => f instanceof BaseSegment
      ).map(f => f.segment);
    }
    const subQuery = this.newSubQuery({
      cubeAliasPrefix: prefix,
      rowLimit: null,
      measures: [{
        expression: symbol.sql,
        cubeName,
        name
      }],
      dimensions: this.primaryKeyNames(cubeName),
      filters,
      segments,
      timeDimensions,
      order: {}
    });
    return { prefix, subQuery, cubeName };
  }

  /**
   *
   * @param {string} cubeName
   * @param {string} name
   * @returns {string}
   */
  subQueryName(cubeName, name) {
    return `${cubeName}_${name}_subquery`;
  }

  regularMeasuresSubQuery(measures, filters) {
    filters = filters || this.allFilters;

    // 检查是否有半累加指标，包含计算指标递归引用到的半累加指标。
    const semiAdditiveMeasuresForCte = this.collectReferencedSemiAdditiveMeasures(measures, filters);
    const hasSemiAdditive = semiAdditiveMeasuresForCte.length > 0;

    const inlineWhereConditions = [];

    const baseQuery = this.rewriteInlineWhere(() => this.joinQuery(
      this.join,
      this.collectFrom(
        this.dimensionsForSelect().concat(measures).concat(semiAdditiveMeasuresForCte).concat(this.allFilters),
        this.collectSubQueryDimensionsFor.bind(this),
        'collectSubQueryDimensionsFor'
      )
    ), inlineWhereConditions);

    // 如果有半累加指标，构建未聚合的内部查询
    if (hasSemiAdditive) {
      return this.buildSemiAdditiveMeasuresQuery(
        measures,
        filters,
        baseQuery,
        { inlineWhereConditions },
      );
    }

    // 原来的逻辑
    const selectClause = `SELECT ${this.selectAllDimensionsAndMeasures(measures)}`;
    const fromClause = `FROM ${baseQuery}`;
    const whereClause = this.baseWhere(filters.concat(inlineWhereConditions));
    const groupByClause = !this.safeEvaluateSymbolContext().ungrouped && this.groupByClause() || '';

    return `${selectClause} ${fromClause} ${whereClause}${groupByClause}`;
  }

  /**
   * Returns SQL query for the "aggregating on top of sub-queries" uses cases.
   * @param {string} keyCubeName
   * @param {Array<BaseMeasure>} measures
   * @param {Array<BaseFilter>} filters
   * @returns {string}
   */
  aggregateSubQuery(keyCubeName, measures, filters) {
    filters = filters || this.allFilters;
    const primaryKeyDimensions = this.primaryKeyNames(keyCubeName).map((k) => this.newDimension(k));
    const shouldBuildJoinForMeasureSelect = this.checkShouldBuildJoinForMeasureSelect(measures, keyCubeName);

    let keyCubeSql;
    let keyCubeAlias;
    let keyCubeInlineLeftJoinConditions;
    const measureSubQueryDimensions = this.collectFrom(
      measures,
      this.collectSubQueryDimensionsFor.bind(this),
      'collectSubQueryDimensionsFor'
    );

    if (shouldBuildJoinForMeasureSelect) {
      const joinHints = this.collectJoinHintsFromMembers(measures);
      const measuresJoin = this.joinGraph.buildJoin(joinHints);
      if (measuresJoin.multiplicationFactor[keyCubeName]) {
        throw new UserError(
          `'${measures.map(m => m.measure).join(', ')}' reference cubes that lead to row multiplication.`
        );
      }
      keyCubeSql = `(${this.aggregateSubQueryMeasureJoin(keyCubeName, measures, measuresJoin, primaryKeyDimensions, measureSubQueryDimensions)})`;
      keyCubeAlias = this.cubeAlias(keyCubeName);
    } else {
      [keyCubeSql, keyCubeAlias, keyCubeInlineLeftJoinConditions] = this.rewriteInlineCubeSql(keyCubeName);
    }

    const measureSelectFn = () => measures.map(m => m.selectColumns());
    const selectedMeasures = shouldBuildJoinForMeasureSelect ? this.evaluateSymbolSqlWithContext(
      measureSelectFn,
      {
        ungroupedAliases: R.fromPairs(measures.map(m => [m.measure, m.aliasName()]))
      }
    ) : measureSelectFn();
    const columnsForSelect = this
      .dimensionColumns(this.escapeColumnName(QueryAlias.AGG_SUB_QUERY_KEYS))
      .concat(selectedMeasures)
      .filter(s => !!s)
      .join(', ');

    const primaryKeyJoinConditions = primaryKeyDimensions.map((pkd) => (
      `${this.escapeColumnName(QueryAlias.AGG_SUB_QUERY_KEYS)
      }.${pkd.aliasName()
      } = ${shouldBuildJoinForMeasureSelect
        ? `${this.cubeAlias(keyCubeName)}.${pkd.aliasName()}`
        : this.dimensionSql(pkd)
      }`
    )).join(' AND ');

    const subQueryJoins =
      shouldBuildJoinForMeasureSelect ? [] : measureSubQueryDimensions.map(d => this.subQueryJoin(d));
    const keysAlias = this.escapeColumnName(QueryAlias.AGG_SUB_QUERY_KEYS);
    const joinSql = this.joinSql([
      {
        sql: `(${this.keysQuery(primaryKeyDimensions, filters)})`,
        alias: keysAlias,
      },
      {
        sql: keyCubeSql,
        alias: keyCubeAlias,
        on: `${primaryKeyJoinConditions}
             ${keyCubeInlineLeftJoinConditions ? ` AND (${keyCubeInlineLeftJoinConditions})` : ''}`,
      },
      ...subQueryJoins
    ]);

    const semiAdditiveMeasuresForCte = this.collectReferencedSemiAdditiveMeasures(measures, filters);
    if (semiAdditiveMeasuresForCte.length > 0) {
      return this.buildSemiAdditiveMeasuresQuery(
        measures,
        filters,
        joinSql,
        {
          skipBaseWhere: true,
          dimensionSourceAlias: keysAlias,
        },
      );
    }

    return `SELECT ${columnsForSelect} FROM ${joinSql}` +
      (!this.safeEvaluateSymbolContext().ungrouped && this.aggregateSubQueryGroupByClause() || '');
  }

  /**
   * @param {Array<BaseMeasure>} measures
   * @param {string} keyCubeName
   * @returns {boolean}
   */
  checkShouldBuildJoinForMeasureSelect(measures, keyCubeName) {
    // When member expression references view, it would have to collect join hints from view
    // Consider join A->B, as many-to-one, so B is multiplied and A is not, and member expression like SUM(AB_view.dimB)
    // Both `collectCubeNamesFor` and `collectJoinHintsFor` would return too many cubes here
    // They both walk join hints, and gather every cube present there
    // For view we would get both A and B, because join hints would go from join tree root
    // Even though expression references only B, and should be OK to use it with B as keyCube
    // So this check would build new join tree from both A and B, B will be multiplied, and that would break check

    return measures.map(measure => {
      const memberNamesForMeasure = this.collectFrom(
        [measure],
        this.collectMemberNamesFor.bind(this),
        'collectMemberNamesFor',
      );

      const nonViewMembers = memberNamesForMeasure
        .map(member => this.memberInstanceByPath(member))
        .filter(member => member.definition().ownedByCube);

      const cubes = this.collectFrom(nonViewMembers, this.collectCubeNamesFor.bind(this), 'collectCubeNamesFor');
      // Not using `collectJoinHintsFromMembers([measure])` because it would collect too many join hints from view
      const joinHints = [
        measure.joinHint,
        ...this.collectJoinHintsFromMembers(nonViewMembers),
      ];
      if (R.any(cubeName => keyCubeName !== cubeName, cubes)) {
        const measuresJoin = this.joinGraph.buildJoin(joinHints);
        if (measuresJoin.multiplicationFactor[keyCubeName]) {
          const measureName = measure.isMemberExpression ? measure.expressionName : measure.measure;
          throw new UserError(
            `'${measureName}' references cubes that lead to row multiplication. Please rewrite it using sub query.`
          );
        }
        return true;
      }
      return false;
    }).reduce((a, b) => a || b);
  }

  aggregateSubQueryMeasureJoin(keyCubeName, measures, measuresJoin, primaryKeyDimensions, measureSubQueryDimensions) {
    return this.ungroupedMeasureSelect(() => this.withCubeAliasPrefix(`${keyCubeName}_measure_join`,
      () => {
        const columns = primaryKeyDimensions.map(p => p.selectColumns()).concat(measures.map(m => m.selectColumns()))
          .filter(s => !!s).join(', ');
        return `SELECT ${columns} FROM ${this.joinQuery(measuresJoin, measureSubQueryDimensions)}`;
      }));
  }

  groupedUngroupedSelect(select, ungrouped, granularityOverride) {
    return this.evaluateSymbolSqlWithContext(
      select,
      { ungrouped, granularityOverride, overTimeSeriesAggregate: true }
    );
  }

  ungroupedMeasureSelect(select) {
    return this.evaluateSymbolSqlWithContext(
      select,
      { ungrouped: true }
    );
  }

  keysQuery(primaryKeyDimensions, filters) {
    const inlineWhereConditions = [];
    const query = this.rewriteInlineWhere(() => this.joinQuery(
      this.join,
      this.collectFrom(
        this.keyDimensions(primaryKeyDimensions),
        this.collectSubQueryDimensionsFor.bind(this),
        'collectSubQueryDimensionsFor'
      )
    ), inlineWhereConditions);
    return `SELECT DISTINCT ${this.keysSelect(primaryKeyDimensions)} FROM ${query
    } ${this.baseWhere(filters.concat(inlineWhereConditions))}`;
  }

  keysSelect(primaryKeyDimensions) {
    return R.flatten(
      this.keyDimensions(primaryKeyDimensions)
        .map(s => s.selectColumns())
    ).filter(s => !!s).join(', ');
  }

  keyDimensions(primaryKeyDimensions) {
    // The same dimension with different granularities maybe requested, so it's not enough to filter only by dimension
    return R.uniqBy(
      (d) => {
        if (d.isMemberExpression) {
          return d.dimension.definition;
        }

        return `${d.dimension}${d.granularity ?? ''}`;
      },
      this.dimensionsForSelect()
        .concat(primaryKeyDimensions)
    );
  }

  /**
   * @param {string} cube
   */
  cubeSql(cube) {
    const foundPreAggregation = this.preAggregations.findPreAggregationToUseForCube(cube);
    if (foundPreAggregation &&
      (!this.options.preAggregationQuery || this.options.useOriginalSqlPreAggregationsInPreAggregation) &&
      !this.safeEvaluateSymbolContext().preAggregationQuery
    ) {
      if (this.safeEvaluateSymbolContext().collectOriginalSqlPreAggregations) {
        this.safeEvaluateSymbolContext().collectOriginalSqlPreAggregations.push(foundPreAggregation);
      }
      return this.preAggregations.originalSqlPreAggregationTable(foundPreAggregation);
    }

    const fromPath = this.cubeEvaluator.cubeFromPath(cube);
    if (fromPath.sqlTable) {
      return this.evaluateSql(cube, fromPath.sqlTable);
    }

    const evaluatedSql = this.evaluateSql(cube, fromPath.sql);
    const selectAsterisk = evaluatedSql.match(/^\s*select\s+\*\s+from\s+([a-zA-Z0-9_\-`".*]+)\s*$/i);
    if (selectAsterisk) {
      return selectAsterisk[1];
    }

    return `(${evaluatedSql})`;
  }

  traverseSymbol(s) {
    // TODO why not just evaluateSymbolSql for every branch?
    if (s.path()) {
      return [s.cube().name].concat(this.evaluateSymbolSql(s.path()[0], s.path()[1], s.definition()));
    } else if (s.patchedMeasure?.patchedFrom) {
      return [s.patchedMeasure.patchedFrom.cubeName].concat(this.evaluateSymbolSql(s.patchedMeasure.patchedFrom.cubeName, s.patchedMeasure.patchedFrom.name, s.definition()));
    } else {
      const res = this.evaluateSql(s.cube().name, s.definition().sql);
      if (s.isJoinCondition) {
        // In a join between Cube A and Cube B, sql() may reference members from other cubes.
        // These referenced cubes must be added as join hints before Cube B to ensure correct SQL generation.
        const targetCube = s.targetCubeName();
        let { joinHints } = this.safeEvaluateSymbolContext();
        joinHints = joinHints.filter(e => e !== targetCube);
        joinHints.push(targetCube);
        this.safeEvaluateSymbolContext().joinHints = joinHints;
      }
      return res;
    }
  }

  /**
   *
   * @returns {Array<string>}
   */
  collectCubeNames() {
    return this.collectFromMembers(
      false,
      this.collectCubeNamesFor.bind(this),
      'collectCubeNamesFor'
    );
  }

  /**
   * Just a helper to avoid copy/paste
   * @private
   * @param {import('../compiler/JoinGraph').FinishedJoinTree} a
   * @param {import('../compiler/JoinGraph').FinishedJoinTree} b
   * @return {boolean}
   */
  isJoinTreesEqual(a, b) {
    if (!a || !b || a.root !== b.root || a.joins.length !== b.joins.length) {
      return false;
    }

    // We don't care about the order of joins on the same level, so
    // we can compare them as sets.
    const aJoinsSet = new Set(a.joins.map(j => `${j.originalFrom}->${j.originalTo}`));
    const bJoinsSet = new Set(b.joins.map(j => `${j.originalFrom}->${j.originalTo}`));

    if (aJoinsSet.size !== bJoinsSet.size) {
      return false;
    }

    for (const val of aJoinsSet) {
      if (!bJoinsSet.has(val)) {
        return false;
      }
    }

    return true;
  }

  /**
   * @private
   * @param {boolean} [excludeTimeDimensions=false]
   * @returns {Array<(Array<string> | string)>}
   */
  collectJoinHints(excludeTimeDimensions = false) {
    const allMembersJoinHints = this.collectJoinHintsFromMembers(this.allMembersConcat(excludeTimeDimensions));
    const queryJoinMaps = this.queryJoinMap();
    const customSubQueryJoinHints = this.collectJoinHintsFromMembers(this.joinMembersFromCustomSubQuery());
    let newCollectedHints = [];

    // One cube may join the other cube via transitive joined cubes,
    // members from which are referenced in the join `on` clauses.
    // We need to collect such join hints and push them upfront of the joining one
    // but only if they don't exist yet. Cause in other case we might affect what
    // join path will be constructed in join graph.
    // It is important to use queryLevelJoinHints during the calculation if it is set.

    const constructJH = () => R.uniq(this.enrichHintsWithJoinMap([
      ...this.queryLevelJoinHints,
      ...newCollectedHints,
      ...allMembersJoinHints,
      ...customSubQueryJoinHints,
    ],
    queryJoinMaps));

    let prevJoin = null;
    let newJoin = null;

    // Safeguard against infinite loop in case of cyclic joins somehow managed to slip through
    let cnt = 0;
    let newJoinHintsCollectedCnt;

    do {
      const allJoinHints = constructJH();
      prevJoin = newJoin;
      newJoin = this.joinGraph.buildJoin(allJoinHints);
      const allJoinHintsFlatten = new Set(allJoinHints.flat());
      const joinMembersJoinHints = this.collectJoinHintsFromMembers(this.joinMembersFromJoin(newJoin));

      const iterationCollectedHints = joinMembersJoinHints.filter(j => !allJoinHintsFlatten.has(j));
      newJoinHintsCollectedCnt = iterationCollectedHints.length;
      cnt++;
      if (newJoin && newJoin.joins.length > 0) {
        // Even if there is no join tree changes, we still
        // push correctly ordered join hints, collected from the resolving of members of join tree
        // upfront the all existing query members. This ensures the correct cube join order
        // with transitive joins even if they are already presented among query members.
        newCollectedHints = this.enrichedJoinHintsFromJoinTree(newJoin, joinMembersJoinHints);
      }
    } while (newJoin?.joins.length > 0 && !this.isJoinTreesEqual(prevJoin, newJoin) && cnt < 10000 && newJoinHintsCollectedCnt > 0);

    if (cnt >= 10000) {
      throw new UserError('Can not construct joins for the query, potential loop detected');
    }

    return constructJH();
  }

  joinMembersFromCustomSubQuery() {
    return this.customSubQueryJoins.map(j => {
      const res = {
        path: () => null,
        cube: () => this.cubeEvaluator.cubeFromPath(j.on.cubeName),
        definition: () => ({
          sql: j.on.expression,
          // TODO use actual type even though it isn't used right now
          type: 'number'
        }),
      };
      return {
        getMembers: () => [res],
      };
    });
  }

  joinMembersFromJoin(join) {
    return join ? join.joins.map(j => ({
      getMembers: () => [{
        path: () => null,
        cube: () => this.cubeEvaluator.cubeFromPath(j.originalFrom),
        definition: () => j.join,
        isJoinCondition: true,
        targetCubeName: () => j.originalTo,
      }]
    })) : [];
  }

  collectJoinHintsFromMembers(members) {
    // Extract cube names from members to make cache key member-cubes-specific
    const memberCubes = members
      .map(m => m.cube?.()?.name)
      .filter(Boolean)
      .sort();

    return [
      ...members.map(m => m.joinHint).filter(h => h?.length > 0),
      ...this.collectFrom(members, this.collectJoinHintsFor.bind(this), ['collectJoinHintsFromMembers', ...memberCubes]),
    ];
  }

  /**
   * @template T
   * @param {boolean} excludeTimeDimensions
   * @param {(t: () => void) => T} fn
   * @param {string | Array<string>} methodName
   * @returns {T}
   */
  collectFromMembers(excludeTimeDimensions, fn, methodName) {
    const membersToCollectFrom = this.allMembersConcat(excludeTimeDimensions)
      .concat(this.join ? this.join.joins.map(j => ({
        getMembers: () => [{
          path: () => null,
          cube: () => this.cubeEvaluator.cubeFromPath(j.originalFrom),
          definition: () => j.join,
        }]
      })) : []);
    return this.collectFrom(membersToCollectFrom, fn, methodName);
  }

  /**
   *
   * @param {boolean} excludeTimeDimensions
   * @returns {Array<BaseMeasure | BaseDimension | BaseSegment>}
   */
  allMembersConcat(excludeTimeDimensions) {
    return this.measures
      .concat(this.dimensions)
      .concat(this.segments)
      .concat(this.filters)
      .concat(this.measureFilters)
      .concat(excludeTimeDimensions ? [] : this.timeDimensions);
  }

  /**
   * @template T
   * @param {Array<unknown>} membersToCollectFrom
   * @param {(t: () => void) => T} fn
   * @param {string | Array<string>} methodName
   * @param {unknown} [cache]
   * @returns {T}
   */
  collectFrom(membersToCollectFrom, fn, methodName, cache) {
    const methodCacheKey = Array.isArray(methodName) ? methodName : [methodName];
    return R.pipe(
      R.map(f => f.getMembers()),
      R.flatten,
      R.map(s => {
        const memberPath = s.path() ? s.path().join('.') : null;
        const hasSqlMask = memberPath &&
          this.maskedMembers && this.maskedMembers.size > 0 &&
          this.maskedMembers.has(memberPath) &&
          s.definition()?.mask && typeof s.definition().mask === 'object' && s.definition().mask.sql;
        return (cache || (hasSqlMask ? this.queryCache : this.compilerCache)).cache(
          ['collectFrom'].concat(methodCacheKey).concat(
            memberPath ? [memberPath] : [s.cube().name, s.expression?.toString() || s.expressionName || s.definition().sql]
          ),
          () => fn(() => this.traverseSymbol(s))
        );
      }),
      R.unnest,
      R.uniq,
      R.filter(R.identity)
    )(
      membersToCollectFrom
    );
  }

  /**
   *
   * @param {() => void} fn
   * @returns {Array<string>}
   */
  collectSubQueryDimensionsFor(fn) {
    const context = { subQueryDimensions: [] };
    this.evaluateSymbolSqlWithContext(
      fn,
      context
    );
    return R.uniq(context.subQueryDimensions);
  }

  rewriteInlineWhere(fn, inlineWhereConditions) {
    const context = { inlineWhereConditions };
    return this.evaluateSymbolSqlWithContext(
      fn,
      context
    );
  }

  /**
   * Returns `GROUP BY` clause for the "aggregating on top of sub-queries" uses
   * cases. By the default returns the result of the `groupByClause` method.
   * @returns {string}
   */
  aggregateSubQueryGroupByClause() {
    return this.groupByClause();
  }

  /**
   * Returns `GROUP BY` clause for the basic uses cases.
   * @returns {string}
   */
  groupByClause() {
    if (this.ungrouped) {
      return '';
    }
    const dimensionColumns = this.dimensionColumns();
    if (!dimensionColumns.length) {
      return '';
    }
    const dimensionNames = dimensionColumns.map((c, i) => `${i + 1}`);
    return this.rollupGroupByClause(dimensionNames);
  }

  /**
   * XXX: String as return value is added because of HiveQuery.getFieldIndex() and DatabricksQuery.getFieldIndex()
   * @protected
   * @param {string} id member name in form of "cube.member[.granularity]"
   * @returns {number|string|null}
   */
  getFieldIndex(id) {
    const equalIgnoreCase = (a, b) => (
      typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()
    );

    let index = -1;
    const path = id.split('.');

    // Granularity is specified
    if (path.length === 3) {
      const memberName = path.slice(0, 2).join('.');
      const granularity = path[2];

      index = this.timeDimensions
        // Not all time dimensions are used in select list, some are just filters,
        // but they exist in this.timeDimensions, so need to filter them out
        .filter(d => d.selectColumns())
        .findIndex(
          d => (
            (equalIgnoreCase(d.dimension, memberName) && (d.granularityObj?.granularity === granularity)) ||
            equalIgnoreCase(d.expressionName, memberName)
          )
        );

      if (index > -1) {
        return index + 1;
      }

      // TODO IT would be nice to log a warning that requested member wasn't found, but we don't have a logger here
      return null;
    }

    const dimensionsForSelect = this.dimensionsForSelect()
      // Not all time dimensions are used in select list, some are just filters,
      // but they exist in this.timeDimensions, so need to filter them out
      .filter(d => d.selectColumns());

    const found = findMinGranularityDimension(id, dimensionsForSelect);
    if (found?.index > -1) {
      return found.index + 1;
    }

    index = this.measures.findIndex(
      d => equalIgnoreCase(d.measure, id) || equalIgnoreCase(d.expressionName, id)
    );

    if (index > -1) {
      const dimensionsCount = this.dimensionColumns().length;
      return index + dimensionsCount + 1;
    }

    return null;
  }

  /**
   * @protected
   * @param {string} id member name in form of "cube.member[.granularity]"
   * @returns {null|string}
   */
  getFieldAlias(id) {
    const equalIgnoreCase = (a, b) => (
      typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()
    );

    let field;

    const path = id.split('.');

    // Granularity is specified
    if (path.length === 3) {
      const memberName = path.slice(0, 2).join('.');
      const granularity = path[2];

      field = this.timeDimensions
        // Not all time dimensions are used in select list, some are just filters,
        // but they exist in this.timeDimensions, so need to filter them out
        .filter(d => d.selectColumns())
        .find(
          d => (
            (equalIgnoreCase(d.dimension, memberName) && (d.granularityObj?.granularity === granularity)) ||
            equalIgnoreCase(d.expressionName, memberName)
          )
        );

      if (field) {
        return field.aliasName();
      }

      return null;
    }

    const dimensionsForSelect = this.dimensionsForSelect()
      // Not all time dimensions are used in select list, some are just filters,
      // but they exist in this.timeDimensions, so need to filter them out
      .filter(d => d.selectColumns());

    const found = findMinGranularityDimension(id, dimensionsForSelect);

    if (found?.dimension) {
      return found.dimension.aliasName();
    }

    field = this.measures.find(
      (d) => equalIgnoreCase(d.measure, id) || equalIgnoreCase(d.expressionName, id),
    );

    if (field) {
      return field.aliasName();
    }

    return null;
  }

  /**
   * Ensures consistent NULL ordering across databases by treating NULL as the minimum value:
   * - ASC  -> NULLS FIRST
   * - DESC -> NULLS LAST
   *
   * Dialects without `NULLS FIRST/LAST` (e.g. MySQL, MSSQL) should override `orderHashToString`.
   *
   * @protected
   * @param {{ desc: boolean }} hash
   * @returns {string}
   */
  orderByNullsOrderingSuffix(hash) {
    return hash && hash.desc ? ' NULLS LAST' : ' NULLS FIRST';
  }

  /**
   * Whether ORDER BY may use SELECT-list position (1-based). MySQL/MSSQL and ClickHouse
   * override to false: MySQL treats `1` in `1 IS NULL` as a literal; ClickHouse rejects
   * ordinal ORDER BY. Those dialects use aliases via `getFieldOrderExpr` instead.
   *
   * @protected
   * @returns {boolean}
   */
  usePositionalOrderBy() {
    return true;
  }

  /**
   * Sort key for ORDER BY. In multi-subquery JOINs, dimensions are selected from q_0
   * but the same alias can exist on joined branches — qualify or use position.
   *
   * @protected
   * @param {string} id
   * @returns {string|null}
   */
  getFieldOrderExpr(id) {
    const equalIgnoreCase = (a, b) => (
      typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()
    );

    const measure = this.measures.find(
      (d) => equalIgnoreCase(d.measure, id) || equalIgnoreCase(d.expressionName, id),
    );

    // Semi-additive queries aggregate inside base_data/windowed_data and are often
    // wrapped as q_0. The outer ORDER BY only sees projected aliases — repeating
    // measureSql() or a wrong SELECT position references windowed_data-only columns
    // (MySQL/DM error) or sorts by the wrong column (Postgres positional drift).
    // Calculated measures (type: number) that reference semi-additive bases always
    // take the q_0 wrap path for the same reason.
    //
    // Safe here because semi-additive queries never use simpleQuery (see buildSqlAndParams
    // fallback guard). MySQL non-semi-additive aggregates still override below in MysqlQuery.
    if (
      measure
      && (
        (typeof measure.isSemiAdditive === 'function' && measure.isSemiAdditive())
        || this.queryReferencesSemiAdditiveMeasures()
        || this.hasPeriodAverageMeasureFilters()
      )
    ) {
      return measure.aliasName();
    }

    const index = this.getFieldIndex(id);
    if (index === null) {
      return null;
    }

    if (this.usePositionalOrderBy()) {
      return String(index);
    }

    const alias = this.getFieldAlias(id);
    if (alias === null) {
      return null;
    }

    const escapedAlias = this.escapeColumnName(this.unquotedColumnName(alias));
    const dimensionCount = this.dimensionColumns().length;
    const isDimension =
      typeof index === 'number'
      && dimensionCount > 0
      && index <= dimensionCount
      && this.orderByJoinAmbiguity;

    if (isDimension) {
      return `q_0.${escapedAlias}`;
    }

    return escapedAlias;
  }

  /**
   * @param {{ id: string, desc: boolean }} hash
   * @returns {string|null}
   */
  orderHashToString(hash) {
    if (!hash || !hash.id) {
      return null;
    }

    const expr = this.getFieldOrderExpr(hash.id);

    if (expr === null) {
      return null;
    }

    const direction = hash.desc ? 'DESC' : 'ASC';
    return `${expr} ${direction}${this.orderByNullsOrderingSuffix(hash)}`;
  }

  orderBy() {
    if (R.isEmpty(this.order)) {
      return '';
    }

    const orderByString = R.pipe(
      R.map(this.orderHashToString),
      R.reject(R.isNil),
      R.join(', ')
    )(this.order);

    if (!orderByString) {
      return '';
    }

    return ` ORDER BY ${orderByString}`;
  }

  /**
   * Returns a complete list of the aliased dimensions, including time
   * dimensions.
   * @returns {Array<string>}
   */
  dimensionAliasNames() {
    return R.flatten(this.dimensionsForSelect().map(d => d.aliasName()).filter(d => !!d));
  }

  /**
   * Returns an array of column names correlated to the specified cube dimensions.
   * @param {string} cubeAlias
   * @returns {Array<string>}
   */
  dimensionColumns(cubeAlias) {
    return this.dimensionAliasNames().map(alias => `${cubeAlias && `${cubeAlias}.` || ''}${alias}`);
  }

  groupByDimensionLimit() {
    let limit = null;
    if (this.rowLimit !== null) {
      if (this.rowLimit === MAX_SOURCE_ROW_LIMIT) {
        limit = this.paramAllocator.allocateParam(MAX_SOURCE_ROW_LIMIT);
      } else if (typeof this.rowLimit === 'number') {
        limit = this.rowLimit;
      }
    }
    const offset = this.offset ? parseInt(this.offset, 10) : null;
    return this.limitOffsetClause(limit, offset);
  }

  /**
   * @protected
   * @param {Array<string>} dimensionNames
   * @returns {string}
   */
  rollupGroupByClause(dimensionNames) {
    if (this.ungrouped) {
      return '';
    }
    const dimensionColumns = this.dimensionColumns();
    if (!dimensionColumns.length) {
      return '';
    }

    const groupingSets = R.flatten(this.dimensionsForSelect().map(d => d.dimension).filter(d => !!d)).map(d => d.groupingSet);

    let result = ' GROUP BY ';

    dimensionColumns.forEach((c, i) => {
      const groupingSet = groupingSets[i];
      const comma = i > 0 ? ', ' : '';
      const prevId = i > 0 ? (groupingSets[i - 1] || { id: null }).id : null;
      const currId = (groupingSet || { id: null }).id;

      if (prevId !== null && currId !== prevId) {
        result += ')';
      }

      if ((prevId === null || currId !== prevId) && groupingSet != null) {
        if (groupingSet.groupType === 'Rollup') {
          result += `${comma}ROLLUP(`;
        } else if (groupingSet.groupType === 'Cube') {
          result += `${comma}CUBE(`;
        }
      } else {
        result += `${comma}`;
      }

      result += dimensionNames[i];
    });
    if (groupingSets[groupingSets.length - 1] != null) {
      result += ')';
    }

    return result;
  }

  /**
   * @protected
   * @param limit
   * @param offset
   * @returns {string}
   */
  limitOffsetClause(limit, offset) {
    const limitClause = limit != null ? ` LIMIT ${limit}` : '';
    const offsetClause = offset != null ? ` OFFSET ${offset}` : '';
    return `${limitClause}${offsetClause}`;
  }

  topLimit() {
    return '';
  }

  baseSelect() {
    return R.flatten(this.forSelect().map(s => s.selectColumns())).filter(s => !!s).join(', ');
  }

  selectAllDimensionsAndMeasures(measures) {
    return R.flatten(
      this.dimensionsForSelect().concat(measures).map(s => s.selectColumns())
    ).filter(s => !!s).join(', ');
  }

  /**
   * @returns {Array<BaseDimension|BaseMeasure>}
   */
  forSelect() {
    return this.dimensionsForSelect().concat(this.measures);
  }

  /**
   * Returns a complete list of the dimensions, including time dimensions.
   * @returns {(BaseDimension|BaseTimeDimension)[]}
   */
  dimensionsForSelect() {
    return this.dimensions.concat(this.timeDimensions);
  }

  dimensionSql(dimension) {
    return this.evaluateSymbolSql(dimension.path()[0], dimension.path()[1], dimension.dimensionDefinition());
  }

  segmentSql(segment) {
    return this.evaluateSymbolSql(segment.path()[0], segment.path()[1], segment.segmentDefinition());
  }

  measureSql(measure) {
    return this.evaluateSymbolSql(measure.path()[0], measure.path()[1], measure.measureDefinition());
  }

  /**
   * 将成员 SQL 中显式写死的当前 cube 名限定列，重写为运行时实际使用的表别名。
   *
   * 这样既保留了模型里使用 `table.column` / `"table"."column"` 规避 join 歧义的写法，
   * 也能兼容多阶段查询、子查询和方言适配场景下动态生成的 `main__cube` / `DM_xxx` 别名。
   *
   * @param {string} cubeName
   * @param {string} sql
   * @returns {string}
   */
  rewriteOwnedCubeQualifiedColumnReferences(cubeName, sql) {
    if (!sql || typeof sql !== 'string' || !cubeName) {
      return sql;
    }

    const cubeAlias = this.cubeAlias(cubeName);
    const escapedCubeName = cubeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result = sql;

    for (const { pattern, replacement } of this.ownedCubeQualifiedColumnReplacements(
      cubeName,
      cubeAlias,
      escapedCubeName,
    )) {
      result = result.replace(pattern, replacement);
    }

    return result;
  }

  /**
   * 各 dialect 应 override，声明如何识别「当前 cube 名 + .」的写法并重写为 cubeAlias。
   *
   * 默认实现覆盖两种最常见的写法：
   *   ① `"cube".col` — 双引号限定（Postgres/Redshift/Snowflake/Presto/Trino/Athena/
   *      SQLite/ClickHouse 等的标准标识符引号，cube 名含大写字母或保留字时几乎必用）；
   *   ② `cube.col`   — 无引号写法（所有库的兜底）。
   *
   * 子类 override 时建议在 `super` 基础上做增量，仅补充本方言特有的引号字符，
   * 例如 MySQL/BigQuery 追加反引号 `​`​`cube``、SQL Server 追加 `[cube]`，
   * 避免遗漏默认已覆盖的双引号写法。
   *
   * @protected
   * @param {string} cubeName
   * @param {string} cubeAlias
   * @param {string} escapedCubeName
   * @returns {{ pattern: RegExp, replacement: string }[]}
   */
  ownedCubeQualifiedColumnReplacements(cubeName, cubeAlias, escapedCubeName) {
    return [
      // ① 双引号：`"cube".col`
      {
        pattern: new RegExp(`"${escapedCubeName}"\\s*\\.`, 'g'),
        replacement: `${cubeAlias}.`,
      },
      // ② 无引号：`cube.col`（排除其后紧跟其它标识符字符的情况）
      {
        pattern: new RegExp(`(^|[^A-Za-z0-9_$."'\`\\[])${escapedCubeName}\\s*\\.`, 'g'),
        replacement: `$1${cubeAlias}.`,
      },
    ];
  }

  autoPrefixWithCubeName(cubeName, sql, isMemberExpr = false) {
    if (!isMemberExpr && sql.match(/^[_a-zA-Z][_a-zA-Z0-9]*$/)) {
      return `${this.cubeAlias(cubeName)}.${sql}`;
    }
    return this.rewriteOwnedCubeQualifiedColumnReferences(cubeName, sql);
  }

  wrapSegmentForDimensionSelect(sql) {
    return sql;
  }

  pushCubeNameForCollectionIfNecessary(cubeName) {
    if ((this.evaluateSymbolContext || {}).cubeNames && cubeName) {
      this.evaluateSymbolContext.cubeNames.push(cubeName);
    }
  }

  pushJoinHints(joinHints) {
    if (this.safeEvaluateSymbolContext().joinHints && joinHints) {
      if (Array.isArray(joinHints) && joinHints.length === 1) {
        [joinHints] = joinHints;
      }
      this.safeEvaluateSymbolContext().joinHints.push(joinHints);
    }
  }

  pushMemberNameForCollectionIfNecessary(cubeName, name) {
    const pathFromArray = this.cubeEvaluator.pathFromArray([cubeName, name]);
    if (!this.cubeEvaluator.getCubeDefinition(cubeName).isView) {
      const joinHints = this.cubeEvaluator.joinHints();
      if (joinHints && joinHints.length) {
        joinHints.forEach(cube => this.pushCubeNameForCollectionIfNecessary(cube));
        this.pushJoinHints(joinHints);
      } else {
        this.pushCubeNameForCollectionIfNecessary(cubeName);
        this.pushJoinHints(cubeName);
      }
    }
    const context = this.safeEvaluateSymbolContext();
    if (context.memberNames && name) {
      context.memberNames.push(pathFromArray);
    }
  }

  safeEvaluateSymbolContext() {
    return this.evaluateSymbolContext || {};
  }

  evaluateSymbolSql(cubeName, name, symbol, memberExpressionType, subPropertyName) {
    const isMemberExpr = !!memberExpressionType;
    if (!memberExpressionType) {
      this.pushMemberNameForCollectionIfNecessary(cubeName, name);
    }
    if (symbol.patchedFrom) {
      this.pushMemberNameForCollectionIfNecessary(symbol.patchedFrom.cubeName, symbol.patchedFrom.name);
    }
    const memberPathArray = [cubeName, name];
    // Member path needs to be expanded to granularity if subPropertyName is provided.
    // Without this: infinite recursion with maximum call stack size exceeded.
    // During resolving within dimensionSql() the same symbol is pushed into the stack.
    // This would not be needed when the subProperty evaluation will be here and no
    // call to dimensionSql().
    if (subPropertyName && symbol.type === 'time') {
      memberPathArray.push('granularities', subPropertyName);
    }
    const memberPath = this.cubeEvaluator.pathFromArray(memberPathArray);
    let type = memberExpressionType;
    if (!type) {
      if (this.cubeEvaluator.isMeasure(memberPathArray)) {
        type = 'measure';
      } else if (this.cubeEvaluator.isDimension(memberPathArray)) {
        type = 'dimension';
      } else if (this.cubeEvaluator.isSegment(memberPathArray)) {
        type = 'segment';
      }
    }

    const parentMember = this.safeEvaluateSymbolContext().currentMember;
    if (this.safeEvaluateSymbolContext().memberChildren && parentMember) {
      this.safeEvaluateSymbolContext().memberChildren[parentMember] = this.safeEvaluateSymbolContext().memberChildren[parentMember] || [];
      if (this.safeEvaluateSymbolContext().memberChildren[parentMember].indexOf(memberPath) === -1) {
        this.safeEvaluateSymbolContext().memberChildren[parentMember].push(memberPath);
      }
    }

    this.safeEvaluateSymbolContext().currentMember = memberPath;
    try {
      const isResultStageMember = this.resultMaskedMembers &&
        this.resultMaskedMembers.size > 0 &&
        this.resultMaskedMembers.has(memberPath);
      if (this.maskedMembers && this.maskedMembers.has(memberPath) && !memberExpressionType &&
          !this.safeEvaluateSymbolContext().skipMasking && !isResultStageMember) {
        // In ungrouped queries, only apply static masks to measures.
        // SQL masks (mask.sql) reference columns that don't apply per-row.
        const isMeasure = type === 'measure';
        const isUngrouped = this.options.ungrouped;
        const hasSqlMask = symbol.mask && typeof symbol.mask === 'object' && symbol.mask.sql;
        if (!isMeasure || !isUngrouped || !hasSqlMask) {
          const maskFilter = this.memberMaskFilters && this.memberMaskFilters[memberPath];
          if (maskFilter) {
            // Conditional masking renders:
            //   CASE WHEN {rowFilter} THEN {value} ELSE {maskedValue} END
            // For aggregate measures this produces invalid SQL on strict GROUP BY
            // engines whenever the row filter references members that are not part
            // of the GROUP BY: the predicate is evaluated at row grain while the
            // measure is aggregated. The same row-level filter is already enforced
            // in the query WHERE clause, so for such measures we render the masked
            // value directly instead of a per-row CASE WHEN. In ungrouped queries
            // the measure is rendered at row grain, so the CASE WHEN is valid and
            // is kept.
            if (isMeasure && !isUngrouped && !this.maskFilterReferencesOnlyGroupByMembers(maskFilter)) {
              return this.memberMaskSql(cubeName, name, symbol);
            }
            return this.conditionalMemberMaskSql(cubeName, name, symbol, maskFilter);
          }
          return this.memberMaskSql(cubeName, name, symbol);
        }
      }

      if (type === 'measure') {
        let parentMeasure;
        if (this.safeEvaluateSymbolContext().compositeCubeMeasures ||
          this.safeEvaluateSymbolContext().leafMeasures) {
          parentMeasure = this.safeEvaluateSymbolContext().currentMeasure;
          if (this.safeEvaluateSymbolContext().compositeCubeMeasures) {
            if (parentMeasure && !memberExpressionType &&
              (
                this.cubeEvaluator.cubeNameFromPath(parentMeasure) !== cubeName ||
                this.newMeasure(memberPath).isCumulative()
              )
            ) {
              this.safeEvaluateSymbolContext().compositeCubeMeasures[parentMeasure] = true;
            }
          }
          this.safeEvaluateSymbolContext().currentMeasure = memberPath;
          if (this.safeEvaluateSymbolContext().leafMeasures) {
            if (parentMeasure) {
              this.safeEvaluateSymbolContext().leafMeasures[parentMeasure] = false;
            }
            this.safeEvaluateSymbolContext().leafMeasures[this.safeEvaluateSymbolContext().currentMeasure] = true;
          }
        }
        const primaryKeys = this.cubeEvaluator.primaryKeys[cubeName];
        const orderBySql = (symbol.orderBy || []).map(o => ({ sql: this.evaluateSql(cubeName, o.sql), dir: o.dir }));
        let sql;
        let patchedSymbol = symbol;
        if (symbol.type !== 'rank') {
          const evaluateSql = () => symbol.sql && this.evaluateSql(cubeName, symbol.sql) ||
            primaryKeys.length && (
              primaryKeys.length > 1 ?
                this.concatStringsSql(primaryKeys.map((pk) => this.castToString(this.primaryKeySql(pk, cubeName))))
                : this.primaryKeySql(primaryKeys[0], cubeName)
            ) || '*';
          // For patched view measures (aggType is set), the view's sql resolves to
          // already-aggregated SQL (e.g. SUM(col)). Filters must be applied inside
          // that aggregation, not outside. We pre-evaluate the filter SQL at the
          // view level, push it down via context, and skip filters at this level.
          const isPatchedViewMeasure = symbol.aggType && symbol.patchedFrom && symbol.filters?.length;
          if (isPatchedViewMeasure) {
            const pushDownFilterSql = this.evaluateFiltersArray(symbol.filters, cubeName);
            sql = this.evaluateSymbolSqlWithContext(evaluateSql, {
              patchMeasurePushDownFilterSql: pushDownFilterSql,
            });
            patchedSymbol = { ...symbol, filters: [] };
          } else {
            sql = evaluateSql();
          }
        }
        const result = this.renderSqlMeasure(
          name,
          sql && this.applyMeasureFilters(
            this.autoPrefixWithCubeName(
              cubeName,
              sql,
              isMemberExpr,
            ),
            patchedSymbol,
            cubeName
          ),
          symbol,
          cubeName,
          parentMeasure,
          orderBySql,
        );
        if (
          this.safeEvaluateSymbolContext().compositeCubeMeasures ||
          this.safeEvaluateSymbolContext().leafMeasures
        ) {
          this.safeEvaluateSymbolContext().currentMeasure = parentMeasure;
        }

        return result;
      } else if (type === 'dimension') {
        if ((this.safeEvaluateSymbolContext().renderedReference || {})[memberPath]) {
          return this.evaluateSymbolContext.renderedReference[memberPath];
        }
        // if (symbol.multiStage) {
        //   const orderBySql = (symbol.orderBy || []).map(o => ({ sql: this.evaluateSql(cubeName, o.sql), dir: o.dir }));
        //   const partitionBy = this.multiStageDimensions.length ? `PARTITION BY ${this.multiStageDimensions.map(d => d.dimensionSql()).join(', ')} ` : '';
        //   if (symbol.type === 'rank') {
        //     return `${symbol.type}() OVER (${partitionBy}ORDER BY ${orderBySql.map(o => `${o.sql} ${o.dir}`).join(', ')})`;
        //   }
        // }
        if (symbol.subQuery) {
          if (this.safeEvaluateSymbolContext().subQueryDimensions) {
            this.safeEvaluateSymbolContext().subQueryDimensions.push(memberPath);
          }
          return this.escapeColumnName(this.aliasName(memberPath));
        }
        if (symbol.case) {
          return this.renderDimensionCase(symbol, cubeName);
        } else if (symbol.type === 'switch') {
          // Dimension of type switch is not supported in BaseQuery, return an empty string to make dependency resolution work.
          return '';
        } else if (symbol.type === 'geo') {
          return this.concatStringsSql([
            this.autoPrefixAndEvaluateSql(cubeName, symbol.latitude.sql, isMemberExpr),
            '\',\'',
            this.autoPrefixAndEvaluateSql(cubeName, symbol.longitude.sql, isMemberExpr)
          ]);
        } else if (symbol.type === 'time' && subPropertyName) {
          // TODO: Beware! memberExpression && shiftInterval are not supported with the current implementation.
          // Ideally this should be implemented (at least partially) here + inside cube symbol evaluation logic.
          // As now `dimensionSql()` is recursively calling `evaluateSymbolSql()` which is not good.
          const td = this.newTimeDimension({
            dimension: this.cubeEvaluator.pathFromArray([cubeName, name]),
            granularity: subPropertyName
          });
          // for time dimension with granularity convertedToTz() is called internally in dimensionSql() flow,
          // so we need to ignore convertTz later even if context convertTzForRawTimeDimension is set to true
          return this.evaluateSymbolSqlWithContext(
            () => td.dimensionSql(),
            { ignoreConvertTzForTimeDimension: true },
          );
        } else {
          let res = this.autoPrefixAndEvaluateSql(cubeName, symbol.sql, isMemberExpr);
          const memPath = this.cubeEvaluator.pathFromArray([cubeName, name]);

          // Skip view's member evaluation as there will be underlying cube's same member evaluation
          if (symbol.type === 'time' && !this.cubeEvaluator.cubeFromPath(memPath).isView) {
            if (this.safeEvaluateSymbolContext().timeShifts?.[memPath]) {
              if (symbol.shiftInterval) {
                throw new UserError(`Hierarchical time shift is not supported but was provided for '${memPath}'. Parent time shift is '${symbol.shiftInterval}' and current is '${this.safeEvaluateSymbolContext().timeShifts?.[memPath]}'`);
              }
              res = `(${this.addTimestampInterval(res, this.safeEvaluateSymbolContext().timeShifts?.[memPath])})`;
            } else if (this.safeEvaluateSymbolContext().commonTimeShift) {
              if (symbol.shiftInterval) {
                throw new UserError(`Hierarchical time shift is not supported but was provided for '${memPath}'. Parent time shift is '${symbol.shiftInterval}' and current is '${this.safeEvaluateSymbolContext().commonTimeShift}'`);
              }
              res = `(${this.addTimestampInterval(res, this.safeEvaluateSymbolContext().commonTimeShift)})`;
            }
          }

          if (this.safeEvaluateSymbolContext().convertTzForRawTimeDimension &&
            !this.safeEvaluateSymbolContext().ignoreConvertTzForTimeDimension &&
            !memberExpressionType &&
            symbol.type === 'time' &&
            this.cubeEvaluator.byPathAnyType(memberPathArray).ownedByCube
          ) {
            res = this.convertTz(res);
          }
          return res;
        }
      } else if (type === 'segment') {
        if ((this.safeEvaluateSymbolContext().renderedReference || {})[memberPath]) {
          return this.evaluateSymbolContext.renderedReference[memberPath];
        }
        return this.autoPrefixWithCubeName(cubeName, this.evaluateSql(cubeName, symbol.sql), isMemberExpr);
      }
      return this.evaluateSql(cubeName, symbol.sql);
    } finally {
      this.safeEvaluateSymbolContext().currentMember = parentMember;
    }
  }

  memberMaskSql(cubeName, name, symbol) {
    const { mask } = symbol;
    if (mask !== undefined && mask !== null) {
      if (typeof mask === 'object' && mask.sql) {
        const sqlCubeName = symbol.aliasMember ? symbol.aliasMember.split('.')[0] : cubeName;
        return this.autoPrefixAndEvaluateSql(sqlCubeName, mask.sql);
      }
      if (typeof mask === 'number') {
        return `${mask}`;
      }
      if (typeof mask === 'boolean') {
        return mask ? 'TRUE' : 'FALSE';
      }
      if (typeof mask === 'string') {
        return this.paramAllocator.allocateParam(mask);
      }
    }
    return this.defaultMaskSql(symbol.type);
  }

  conditionalMemberMaskSql(cubeName, name, symbol, maskFilter) {
    const maskedSql = this.memberMaskSql(cubeName, name, symbol);
    const result = this.evaluateSymbolSqlWithContext(
      () => {
        const filterSql = this.maskFilterToSql(maskFilter);
        if (!filterSql) {
          return maskedSql;
        }
        const originalSql = this.autoPrefixAndEvaluateSql(cubeName, symbol.sql);
        return this.caseWhenStatement([{ sql: filterSql, label: originalSql }], maskedSql);
      },
      { skipMasking: true, currentMember: null }
    );
    return result;
  }

  // Collects all member paths (member/dimension/measure) referenced anywhere in a
  // (possibly nested and/or) filter tree.
  collectFilterMemberPaths(filter, acc = []) {
    if (!filter) {
      return acc;
    }
    if (Array.isArray(filter)) {
      filter.forEach(f => this.collectFilterMemberPaths(f, acc));
      return acc;
    }
    if (filter.and) {
      this.collectFilterMemberPaths(filter.and, acc);
    }
    if (filter.or) {
      this.collectFilterMemberPaths(filter.or, acc);
    }
    const member = filter.member || filter.dimension || filter.measure;
    if (member) {
      acc.push(member);
    }
    return acc;
  }

  // Returns true when every member referenced by the mask filter is part of the
  // query GROUP BY (regular dimensions or time dimensions with a granularity).
  // Conditional masking via CASE WHEN can only be applied to an aggregate measure
  // when the filter predicate is evaluated against grouped columns; otherwise the
  // generated SQL references ungrouped columns and fails on strict GROUP BY engines.
  maskFilterReferencesOnlyGroupByMembers(maskFilter) {
    const filterMembers = [...new Set(this.collectFilterMemberPaths(maskFilter))];
    if (!filterMembers.length) {
      return false;
    }
    const groupByMembers = new Set([
      ...this.dimensions
        .filter(d => !d.isMemberExpression && d.dimension)
        .map(d => d.dimension),
      ...this.timeDimensions
        .filter(td => td.granularity && td.dimension)
        .map(td => td.dimension),
    ]);
    return filterMembers.every(m => groupByMembers.has(m));
  }

  maskFilterToSql(filter) {
    if (!filter) return null;
    const filterItems = this.extractFiltersAsTree([filter]);
    if (!filterItems.length) return null;
    const initialized = filterItems.map(this.initFilter.bind(this));
    if (initialized.length === 1) {
      return initialized[0].filterToWhere();
    }
    const groupFilter = this.newGroupFilter({
      operator: 'and',
      values: initialized,
    });
    return groupFilter.filterToWhere();
  }

  defaultMaskSql(memberType) {
    const envMasks = {
      string: getEnv('accessPolicyMaskString'),
      time: getEnv('accessPolicyMaskTime'),
      boolean: getEnv('accessPolicyMaskBoolean'),
      number: getEnv('accessPolicyMaskNumber'),
    };
    const envMask = envMasks[memberType];
    if (envMask !== undefined && envMask !== null) {
      if (memberType === 'number') {
        return `${envMask}`;
      }
      if (memberType === 'boolean') {
        return envMask.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
      }
      return this.paramAllocator.allocateParam(envMask);
    }
    return 'NULL';
  }

  escapeStringLiteral(str) {
    return `'${str.replace(/'/g, '\'\'')}'`;
  }

  autoPrefixAndEvaluateSql(cubeName, sql, isMemberExpr = false) {
    return this.autoPrefixWithCubeName(cubeName, this.evaluateSql(cubeName, sql), isMemberExpr);
  }

  concatStringsSql(strings) {
    return strings.join(' || ');
  }

  /**
   *
   * @param {string} cubeName
   * @returns {Array<string>}
   */
  primaryKeyNames(cubeName) {
    const primaryKeys = this.cubeEvaluator.primaryKeys[cubeName];
    if (!primaryKeys || !primaryKeys.length) {
      throw new UserError(`One or more Primary key is required for '${cubeName}' cube`);
    }
    return primaryKeys.map((pk) => this.primaryKeyName(cubeName, pk));
  }

  primaryKeyName(cubeName, primaryKey) {
    return `${cubeName}.${primaryKey}`;
  }

  evaluateSql(cubeName, sql, options) {
    options = options || {};
    const self = this;
    const { cubeEvaluator } = this;
    return cubeEvaluator.resolveSymbolsCall(sql, (name) => {
      const nextCubeName = cubeEvaluator.symbols[name] && name || cubeName;
      const resolvedSymbol =
        cubeEvaluator.resolveSymbol(
          cubeName,
          name
        );
      // eslint-disable-next-line no-underscore-dangle
      if (resolvedSymbol._objectWithResolvedProperties) {
        return resolvedSymbol;
      }
      return self.evaluateSymbolSql(nextCubeName, name, resolvedSymbol);
    }, {
      sqlResolveFn: options.sqlResolveFn || ((symbol, cube, propName, subPropName) => self.evaluateSymbolSql(cube, propName, symbol, false, subPropName)),
      cubeAliasFn: self.cubeAlias.bind(self),
      contextSymbols: this.parametrizedContextSymbols(),
      query: this,
      collectJoinHints: true,
    });
  }

  withCubeAliasPrefix(cubeAliasPrefix, fn) {
    return this.evaluateSymbolSqlWithContext(fn, { cubeAliasPrefix });
  }

  /**
   * Evaluate escaped SQL-alias for cube or cube's property
   * (measure, dimension).
   * @param {string} cubeName
   * @returns string
   */
  cubeAlias(cubeName) {
    const prefix = this.safeEvaluateSymbolContext().cubeAliasPrefix || this.cubeAliasPrefix;
    return this.escapeColumnName(
      this.aliasName(
        `${prefix
          ? prefix + '__' + this.aliasName(cubeName)
          : cubeName}`
      )
    );
  }

  /**
   *
   * @param fn
   * @returns {Array<string>}
   */
  collectCubeNamesFor(fn) {
    const context = { cubeNames: [] };
    this.evaluateSymbolSqlWithContext(
      fn,
      context
    );

    return R.uniq(context.cubeNames);
  }

  collectJoinHintsFor(fn) {
    const context = { joinHints: [] };
    this.evaluateSymbolSqlWithContext(
      fn,
      context
    );
    return context.joinHints;
  }

  /**
   *
   * @param fn
   * @returns {Array<string>}
   */
  collectMemberNamesFor(fn) {
    const context = { memberNames: [] };
    this.evaluateSymbolSqlWithContext(
      fn,
      context
    );

    return R.uniq(context.memberNames);
  }

  collectAllMemberNames() {
    return R.flatten(this.collectFromMembers(false, this.collectMemberNamesFor.bind(this), 'collectAllMemberNames'));
  }

  collectMultipliedMeasures(context) {
    return (fn) => {
      const foundCompositeCubeMeasures = {};
      this.evaluateSymbolSqlWithContext(
        fn,
        { ...context, compositeCubeMeasures: foundCompositeCubeMeasures }
      );

      const renderContext = {
        ...context, measuresToRender: [], foundCompositeCubeMeasures, compositeCubeMeasures: {}, rootMeasure: {}
      };
      this.evaluateSymbolSqlWithContext(
        fn,
        renderContext
      );
      return renderContext.measuresToRender.length ?
        R.uniq(renderContext.measuresToRender) :
        [renderContext.rootMeasure.value];
    };
  }

  collectLeafMeasures(fn) {
    const context = { leafMeasures: {} };
    this.evaluateSymbolSqlWithContext(
      fn,
      context
    );
    return R.pipe(
      R.toPairs,
      R.map(([measure, isLeaf]) => isLeaf && measure),
      R.filter(R.identity)
    )(context.leafMeasures);
  }

  /**
   * @template T
   * @param {() => T} fn
   * @param {unknown} context
   * @returns {T}
   */
  evaluateSymbolSqlWithContext(fn, context) {
    const oldContext = this.evaluateSymbolContext;
    this.evaluateSymbolContext = oldContext ? Object.assign({}, oldContext, context) : context;
    try {
      const result = fn();
      this.evaluateSymbolContext = oldContext;
      return result;
    } finally {
      this.evaluateSymbolContext = oldContext;
    }
  }

  renderSqlMeasure(name, evaluateSql, symbol, cubeName, parentMeasure, orderBySql) {
    const multiplied = this.multipliedJoinRowResult(cubeName) || false;
    const measurePath = `${cubeName}.${name}`;
    let resultMultiplied = multiplied;
    if (multiplied && (
      symbol.type === 'countDistinct' ||
      !this.safeEvaluateSymbolContext().hasMultipliedForPreAggregation && (
        symbol.type === 'number' && evaluateSql === 'count(*)' ||
        symbol.type === 'count' && !symbol.sql
      )
    )) {
      resultMultiplied = false;
    }
    if (parentMeasure &&
      (this.safeEvaluateSymbolContext().foundCompositeCubeMeasures || {})[parentMeasure] &&
      !(this.safeEvaluateSymbolContext().foundCompositeCubeMeasures || {})[measurePath]
    ) {
      this.safeEvaluateSymbolContext().measuresToRender.push({ multiplied: resultMultiplied, measure: measurePath, multiStage: symbol.multiStage });
    }
    if (this.safeEvaluateSymbolContext().foundCompositeCubeMeasures && !parentMeasure) {
      this.safeEvaluateSymbolContext().rootMeasure.value = { multiplied: resultMultiplied, measure: measurePath, multiStage: symbol.multiStage };
    }
    if (((this.evaluateSymbolContext || {}).renderedReference || {})[measurePath]) {
      if (this.shouldUseRenderedReferenceForMeasurePath(measurePath)) {
        return this.evaluateSymbolContext.renderedReference[measurePath];
      }
    }
    if (
      this.safeEvaluateSymbolContext().ungrouped ||
      this.safeEvaluateSymbolContext().ungroupedForWrappingGroupBy
    ) {
      return evaluateSql === '*' ? '1' : evaluateSql;
    }
    if (this.ungrouped) {
      if (this.safeEvaluateSymbolContext().ungroupedAliases?.[measurePath]) {
        evaluateSql = this.safeEvaluateSymbolContext().ungroupedAliases[measurePath];
      }
      if ((this.safeEvaluateSymbolContext().ungroupedAliasesForCumulative || {})[measurePath]) {
        evaluateSql = this.safeEvaluateSymbolContext().ungroupedAliasesForCumulative[measurePath];
      }

      if (symbol.type === 'count' || symbol.type === 'countDistinct' || symbol.type === 'countDistinctApprox') {
        const sql = this.caseWhenStatement([{ sql: `(${evaluateSql}) IS NOT NULL`, label: '1' }]);
        return evaluateSql === '*' ? '1' : sql;
      } else {
        return evaluateSql;
      }
    }
    if ((this.safeEvaluateSymbolContext().ungroupedAliases || {})[measurePath]) {
      evaluateSql = (this.safeEvaluateSymbolContext().ungroupedAliases || {})[measurePath];
    }
    if ((this.safeEvaluateSymbolContext().ungroupedAliasesForCumulative || {})[measurePath]) {
      evaluateSql = (this.safeEvaluateSymbolContext().ungroupedAliasesForCumulative || {})[measurePath];
      const { topLevelMerge } = this.safeEvaluateSymbolContext();
      const onGroupedColumn = this.aggregateOnGroupedColumn(
        symbol, evaluateSql, topLevelMerge != null ? topLevelMerge : true, measurePath
      );
      if (onGroupedColumn) {
        return onGroupedColumn;
      }
    }
    if (symbol.multiStage) {
      const partitionBy = (this.multiStageDimensions.length || this.multiStageTimeDimensions.length) ?
        `PARTITION BY ${this.multiStageDimensions.concat(this.multiStageTimeDimensions).map(d => d.dimensionSql()).join(', ')} ` : '';
      if (symbol.type === 'rank') {
        return `${symbol.type}() OVER (${partitionBy}ORDER BY ${orderBySql.map(o => `${o.sql} ${o.dir}`).join(', ')})`;
      }
      if (!(
        R.equals(this.multiStageDimensions.map(d => d.expressionPath()), this.dimensions.map(d => d.expressionPath())) &&
        R.equals(this.multiStageTimeDimensions.map(d => d.expressionPath()), this.timeDimensions.map(d => d.expressionPath()))
      )) {
        let funDef;
        if (symbol.type === 'countDistinctApprox') {
          funDef = this.countDistinctApprox(evaluateSql);
        } else if (symbol.type === 'countDistinct' || symbol.type === 'count' && !symbol.sql && multiplied) {
          funDef = `count(distinct ${evaluateSql})`;
        } else if (CubeSymbols.isCalculatedMeasureType(symbol.type)) {
          // TODO calculated measure type will be ungrouped
          // if (this.multiStageDimensions.length !== this.dimensions.length) {
          //   throw new UserError(`Calculated measure '${measurePath}' uses group_by or reduce_by context modifiers while it isn't allowed`);
          // }
          return evaluateSql;
        } else {
          funDef = `${symbol.type}(${symbol.type}(${evaluateSql}))`;
        }
        return `${funDef} OVER(${partitionBy})`;
      }
    }
    if (symbol.type === 'countDistinctApprox') {
      return this.safeEvaluateSymbolContext().overTimeSeriesAggregate || this.options.preAggregationQuery ?
        this.hllInit(evaluateSql) :
        this.countDistinctApprox(evaluateSql);
    } else if (symbol.type === 'countDistinct' || symbol.type === 'count' && !symbol.sql && multiplied) {
      return `count(distinct ${evaluateSql})`;
    } else if (symbol.type === 'runningTotal') {
      return `sum(${evaluateSql})`; // TODO
    }
    if (multiplied) {
      if (symbol.type === 'number' && evaluateSql === 'count(*)') {
        return this.primaryKeyCount(cubeName, true);
      }
    }
    if (CubeSymbols.isCalculatedMeasureType(symbol.type)) {
      return evaluateSql;
    }
    return `${symbol.type}(${evaluateSql})`;
  }

  aggregateOnGroupedColumn(symbol, evaluateSql, topLevelMerge, measurePath) {
    const cumulativeMeasureFilters = (this.safeEvaluateSymbolContext().cumulativeMeasureFilters || {})[measurePath];
    if (cumulativeMeasureFilters) {
      const sql = cumulativeMeasureFilters.filterToWhere();
      if (sql) {
        evaluateSql = this.caseWhenStatement([{ sql, label: evaluateSql }]);
      }
    }
    if (symbol.type === 'count' || symbol.type === 'sum') {
      return `sum(${evaluateSql})`;
    } else if (symbol.type === 'countDistinctApprox') {
      return topLevelMerge ? this.hllCardinalityMerge(evaluateSql) : this.hllMergeOnly(evaluateSql);
    } else if (symbol.type === 'min' || symbol.type === 'max') {
      return `${symbol.type}(${evaluateSql})`;
    }
    return undefined;
  }

  topAggregateWrap(symbol, evaluateSql) {
    if (symbol.type === 'countDistinctApprox') {
      return this.hllCardinality(evaluateSql);
    }
    return evaluateSql;
  }

  hllInit(_sql) {
    throw new UserError('Distributed approximate distinct count is not supported by this DB');
  }

  hllMerge(_sql) {
    throw new UserError('Distributed approximate distinct count is not supported by this DB');
  }

  hllCardinality(_sql) {
    throw new UserError('Distributed approximate distinct count is not supported by this DB');
  }

  hllMergeOnly(sql) {
    return this.hllMerge(sql);
  }

  hllCardinalityMerge(sql) {
    return this.hllMerge(sql);
  }

  castToString(sql) {
    return `CAST(${sql} as TEXT)`;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  countDistinctApprox(sql) {
    throw new UserError('Approximate distinct count is not supported by this DB');
  }

  primaryKeyCount(cubeName, distinct) {
    const primaryKeys = this.cubeEvaluator.primaryKeys[cubeName];
    const primaryKeySql = primaryKeys.length > 1 ?
      this.concatStringsSql(primaryKeys.map((pk) => this.castToString(this.primaryKeySql(pk, cubeName)))) :
      this.primaryKeySql(primaryKeys[0], cubeName);
    return `count(${distinct ? 'distinct ' : ''}${primaryKeySql})`;
  }

  renderDimensionCase(symbol, cubeName) {
    const when = symbol.case.when.map(w => ({
      sql: this.evaluateSql(cubeName, w.sql),
      label: this.renderDimensionCaseLabel(w.label, cubeName)
    }));
    return this.caseWhenStatement(
      when,
      symbol.case.else && this.renderDimensionCaseLabel(symbol.case.else.label, cubeName)
    );
  }

  renderDimensionCaseLabel(label, cubeName) {
    if (typeof label === 'object' && label.sql) {
      return this.evaluateSql(cubeName, label.sql);
    }
    return `'${label}'`;
  }

  caseWhenStatement(when, elseLabel) {
    return `CASE
    ${when.map(w => `WHEN ${w.sql} THEN ${w.label}`).join('\n')}${elseLabel ? ` ELSE ${elseLabel}` : ''} END`;
  }

  applyMeasureFilters(evaluateSql, symbol, cubeName) {
    const pushDownFilterSql = this.safeEvaluateSymbolContext().patchMeasurePushDownFilterSql;
    const hasOwnFilters = symbol.filters && symbol.filters.length;

    if (!hasOwnFilters && !pushDownFilterSql) {
      return evaluateSql;
    }

    const parts = [];
    if (hasOwnFilters) {
      parts.push(this.evaluateMeasureFilters(symbol, cubeName));
    }
    if (pushDownFilterSql) {
      parts.push(pushDownFilterSql);
    }
    const where = parts.join(' AND ');

    return `CASE WHEN ${where} THEN ${evaluateSql === '*' ? '1' : evaluateSql} END`;
  }

  evaluateMeasureFilters(symbol, cubeName) {
    return this.evaluateFiltersArray(symbol.filters, cubeName);
  }

  evaluateFiltersArray(filtersArray, cubeName) {
    return filtersArray.map(f => this.evaluateSql(cubeName, f.sql))
      .map(s => `(${s})`).join(' AND ');
  }

  /**
   * @param {string} primaryKeyName
   * @param {string} cubeName
   * @returns {unknown}
   */
  primaryKeySql(primaryKeyName, cubeName) {
    const primaryKeyDimension = this.cubeEvaluator.dimensionByPath([cubeName, primaryKeyName]);
    return this.evaluateSymbolSql(
      cubeName,
      primaryKeyName,
      primaryKeyDimension
    );
  }

  /**
   * @param cubeName
   * @returns Boolean
   */
  multipliedJoinRowResult(cubeName) {
    // this.join not initialized on collectCubeNamesForSql
    return this.join && this.join.multiplicationFactor[cubeName];
  }

  inDbTimeZone(date) {
    return localTimestampToUtc(this.timezone, this.timestampFormat(), date);
  }

  /**
   * @return {string}
   */
  timestampFormat() {
    return 'YYYY-MM-DD[T]HH:mm:ss.SSS[Z]';
  }

  /**
   * @return {number}
   */
  timestampPrecision() {
    return 3;
  }

  /**
   * @param {string} field
   * @return {string}
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  convertTz(field) {
    throw new Error('Not implemented');
  }

  /**
   * URL-encode a SQL expression. Override in dialect-specific query classes
   * for native URL encoding support. Default implementation uses REPLACE
   * chains for the most common characters.
   * @param {string} sql
   * @return {string}
   */
  urlEncode(sql) {
    return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(CAST(${sql} as TEXT), '%', '%25'), '&', '%26'), '=', '%3D'), '+', '%2B'), ' ', '%20')`;
  }

  /**
   * @param {string} granularity
   * @param {string} dimension
   * @return {string}
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  timeGroupedColumn(granularity, dimension) {
    throw new Error('Not implemented');
  }

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
  }

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
  }

  periodAverageDataPreAggregateUnitColumnAlias(measure) {
    return this.escapeColumnName(`__pa_unit_${measure.unescapedAliasName()}`);
  }

  periodAverageDataPreAggregateSumColumnAlias(measure) {
    return this.escapeColumnName(`__pa_sum_${measure.unescapedAliasName()}`);
  }

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
  }

  periodAverageDataPreAggregateUnitBucketSql(measure) {
    const periodAverage = measure.measureDefinition().periodAverage;
    const schemaTimeDimension = periodAverage.timeDimension;
    const tdSql = this.periodAverageTimeDimensionSql(schemaTimeDimension);
    return this.periodAverageToDateExpr(this.timeGroupedColumn(periodAverage.avgUnit, tdSql));
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  periodAverageSemiAdditiveBaseColumnAlias(measure) {
    return this.escapeColumnName(`__pa_base_${measure.unescapedAliasName()}`);
  }

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
  }

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
  }

  periodAverageSemiAdditiveBaseRawSql(measure) {
    const basePath = this.periodAverageBaseMeasurePath(measure);
    if (!basePath) {
      return null;
    }
    const baseMeasure = this.newMeasure(basePath);
    const cubeName = baseMeasure.cube().name;
    const symbol = baseMeasure.measureDefinition();
    const sql = symbol.sql && this.evaluateSql(cubeName, symbol.sql);
    if (!sql) {
      return null;
    }
    return this.applyMeasureFilters(
      this.autoPrefixWithCubeName(cubeName, sql, false),
      symbol,
      cubeName,
    );
  }

  /**
   * Derive the configured interval bucket from the query avg_unit GROUP BY expression.
   * Must not reference raw time_dimension SQL — PostgreSQL requires window PARTITION BY
   * expressions to be based on grouped columns.
   */
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
  }

  periodAverageGranularityRank(g) {
    const rank = { day: 0, week: 1, month: 2, quarter: 3, year: 4 };
    return rank[g] ?? 99;
  }

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
  }

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
  }

  periodAverageIntervalBucketSql(timeDimension, interval) {
    const tdSql = this.periodAverageTimeDimensionSql(timeDimension);
    const queryTimeDim = this.periodAverageQueryTimeDimension(timeDimension);
    if (queryTimeDim?.granularity === interval) {
      return queryTimeDim.dimensionSql();
    }
    return this.timeGroupedColumn(interval, tdSql);
  }

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
  }

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
  }

  periodAverageCumulativeDataDivisor(intervalBucket, avgUnitBucket) {
    const partitionBy = this.periodAverageGroupedBucketExpr(intervalBucket);
    const orderBy = this.periodAverageGroupedBucketExpr(avgUnitBucket);
    return `COUNT(*) OVER (PARTITION BY ${partitionBy} ORDER BY ${orderBy} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
  }

  normalizeTimeDimensionInput(timeDimension) {
    if (!timeDimension?.dimension) {
      return timeDimension;
    }

    const parts = timeDimension.dimension.split('.');
    if (!timeDimension.granularity && parts.length === 3) {
      return {
        ...timeDimension,
        dimension: parts.slice(0, 2).join('.'),
        granularity: parts[2],
      };
    }

    return timeDimension;
  }

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
  }

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
  }

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
  }

  periodAverageMatchingTimeDimension(timeDimension) {
    return this.periodAveragePickMatchingTimeDimension(
      timeDimension,
      this.periodAverageQueryTimeDimensionCandidates(),
    );
  }

  periodAverageTimeDimensionSql(timeDimension) {
    const [cubeName, dimName] = timeDimension.split('.');
    const symbol = this.cubeEvaluator.dimensionByPath(timeDimension);
    return this.convertTz(this.evaluateSymbolSql(cubeName, dimName, symbol, 'dimension'));
  }

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
  }

  /**
   * 日期字面量。
   * @dialect 必须重写：默认实现为 PostgreSQL 的 `'...'::date`，
   *          适配新数据库时需改为该库的日期字面量写法（如 `DATE('...')` / `DATE '...'`）。
   */
  periodAverageDateLiteral(dateStr) {
    return `'${dateStr}'::date`;
  }

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
  }

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
  }

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
  }

  periodAverageScopeEndExpr(endExpr) {
    return endExpr;
  }

  /**
   * 把任意日期/时间表达式强制转为 DATE 类型。
   * @dialect 必须重写：默认实现为 PostgreSQL 的 `(...)::date`，
   *          适配新数据库时需改为该库的类型转换写法（如 `CAST(... AS DATE)` / `DATE(...)`）。
   */
  periodAverageToDateExpr(sql) {
    return `(${sql})::date`;
  }

  /**
   * 两个日期之间的自然日数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的日期相减语法，
   *          适配新数据库时需改为该库的日期差函数（如 `DATEDIFF` / `CAST AS DATE 相减`）。
   */
  daysBetweenInclusive(start, end) {
    return `GREATEST((${end} - ${start} + 1), 0)`;
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  periodAverageCalendarBucketDivisor(avgUnit, interval, bucketColumn, queryGranularity) {
    const groupedBucket = this.periodAverageGroupedBucketExpr(bucketColumn, { aggregateOnce: true });
    const bucketAlreadyAtInterval = queryGranularity === interval;
    return this.periodAverageCalendarUnitsInIntervalBucket(
      avgUnit,
      interval,
      groupedBucket,
      bucketAlreadyAtInterval,
    );
  }

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
  }

  /**
   * 两个日期之间的自然月数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `EXTRACT/AGE`，
   *          适配新数据库时需改为该库的月份差函数（如 `TIMESTAMPDIFF(MONTH,...)` / `MONTHS_BETWEEN`）。
   */
  monthsBetweenInclusive(start, end) {
    return `GREATEST((EXTRACT(YEAR FROM AGE(${end}, ${start}))::int * 12 + EXTRACT(MONTH FROM AGE(${end}, ${start}))::int + 1), 0)`;
  }

  /**
   * 两个日期之间的自然季度数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `EXTRACT/AGE`，
   *          适配新数据库时需改为该库的季度差函数（如 `TIMESTAMPDIFF(QUARTER,...)` / `MONTHS_BETWEEN/3`）。
   */
  quartersBetweenInclusive(start, end) {
    return `GREATEST((EXTRACT(YEAR FROM AGE(${end}, ${start}))::int * 4 + FLOOR(EXTRACT(MONTH FROM AGE(${end}, ${start}))::int / 3) + 1), 0)`;
  }

  /**
   * 两个日期之间的自然年数（含首尾，闭区间）。
   * @dialect 必须重写：默认实现用 PostgreSQL 的 `EXTRACT/AGE`，
   *          适配新数据库时需改为该库的年份差函数（如 `TIMESTAMPDIFF(YEAR,...)` / `MONTHS_BETWEEN/12`）。
   */
  yearsBetweenInclusive(start, end) {
    return `GREATEST((EXTRACT(YEAR FROM AGE(${end}, ${start}))::int + 1), 0)`;
  }

  /**
   * Returns sql for source expression floored to timestamps aligned with
   * intervals relative to origin timestamp point
   * @param {string} interval (a value expression of type interval)
   * @param {string} source (a value expression of type timestamp/date)
   * @param {string} origin (a value expression of type timestamp/date without timezone)
   * @returns {string}
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dateBin(interval, source, origin) {
    throw new Error('Date bin function, required for custom time dimension granularities, is not implemented for this data source');
    // Different syntax possible in different DBs
  }

  /**
   * Returns the lowest time unit for the interval
   * @protected
   * @param {string} interval
   * @returns {string}
   */
  diffTimeUnitForInterval(interval) {
    if (/second/i.test(interval)) {
      return 'second';
    } else if (/minute/i.test(interval)) {
      return 'minute';
    } else if (/hour/i.test(interval)) {
      return 'hour';
    } else if (/day/i.test(interval)) {
      return 'day';
    } else if (/week/i.test(interval)) {
      return 'day';
    } else if (/month/i.test(interval)) {
      return 'month';
    } else if (/quarter/i.test(interval)) {
      return 'month';
    } else /* if (/year/i.test(interval)) */ {
      return 'year';
    }
  }

  /**
   * @param {string} dimension
   * @param {import('./Granularity').Granularity} granularity
   * @return {string}
   */
  dimensionTimeGroupedColumn(dimension, granularity) {
    let dtDate;

    // Interval is aligned with natural calendar, so we can use DATE_TRUNC
    if (granularity.isNaturalAligned()) {
      if (granularity.granularityOffset) {
        // Example: DATE_TRUNC(interval, dimension - INTERVAL 'offset') + INTERVAL 'offset'
        dtDate = this.subtractInterval(dimension, granularity.granularityOffset);
        dtDate = this.timeGroupedColumn(granularity.granularityFromInterval(), dtDate);
        dtDate = this.addInterval(dtDate, granularity.granularityOffset);

        return dtDate;
      }

      return this.timeGroupedColumn(granularity.granularityFromInterval(), dimension);
    }

    return this.dateBin(granularity.granularityInterval, dimension, granularity.originLocalFormatted());
  }

  /**
   * Evaluate alias for specific cube's property.
   * @param {string} name Property name.
   * @param {boolean?} isPreAggregationName Pre-agg flag.
   * @returns {string}
   */
  aliasName(name, isPreAggregationName = false) {
    if (this.options.memberToAlias && this.options.memberToAlias[name]) {
      return this.options.memberToAlias[name];
    }
    const path = name.split('.');
    if (path[0] && this.cubeEvaluator.cubeExists(path[0]) && this.cubeEvaluator.cubeFromPath(path[0]).sqlAlias) {
      const cubeName = path[0];
      path.splice(0, 1);
      path.unshift(this.cubeEvaluator.cubeFromPath(cubeName).sqlAlias);
      name = this.cubeEvaluator.pathFromArray(path);
    }
    // TODO: https://github.com/cube-js/cube.js/issues/4019
    // use single underscore for pre-aggregations to avoid fail of pre-aggregation name replace
    const lowercaseName = name.toLowerCase();
    if (lowercaseName === '__user' || lowercaseName === '__cubejoinfield') {
      return name;
    }
    return inflection.underscore(name).replace(/\./g, isPreAggregationName ? '_' : '__');
  }

  /**
   *
   * @param {unknown} options
   * @returns {this}
   */
  newSubQuery(options) {
    const QueryClass = this.constructor;
    return new QueryClass(this.compilers, this.subQueryOptions(options));
  }

  newSubQueryForCube(cube, options) {
    options = { ...options };
    if (this.options.queryFactory) {
      // When dealing with rollup joins, it's crucial to use the correct parameter allocator for the specific cube in use.
      // By default, we'll use BaseQuery, but it's important to note that different databases (Oracle, PostgreSQL, MySQL, Druid, etc.)
      // have unique parameter allocator symbols. Using the wrong allocator can break the query, especially when rollup joins involve
      // different cubes that require different allocators.
      return this.options.queryFactory.createQuery(cube, this.compilers, { ...this.subQueryOptions(options), paramAllocator: null });
    }

    return this.newSubQuery(options);
  }

  subQueryOptions(options) {
    return {
      paramAllocator: this.paramAllocator,
      timezone: this.timezone,
      preAggregationQuery: this.options.preAggregationQuery,
      useOriginalSqlPreAggregationsInPreAggregation: this.options.useOriginalSqlPreAggregationsInPreAggregation,
      contextSymbols: this.contextSymbols,
      preAggregationsSchema: this.preAggregationsSchemaOption,
      cubeLatticeCache: this.options.cubeLatticeCache,
      historyQueries: this.options.historyQueries,
      externalQueryClass: this.options.externalQueryClass,
      queryFactory: this.options.queryFactory,
      useNativeSqlPlanner: this.options.useNativeSqlPlanner,
      ...options,
    };
  }

  cacheKeyQueries(transformFn) { // TODO collect sub queries
    if (!this.safeEvaluateSymbolContext().preAggregationQuery) {
      const preAggregationForQuery = this.preAggregations.findPreAggregationForQuery();
      if (preAggregationForQuery) {
        return [];
      }
    }

    return this.refreshKeysByCubes(this.allCubeNames, transformFn);
  }

  refreshKeysByCubes(cubes, transformFn) {
    const refreshKeyQueryByCube = (cube) => {
      const cubeFromPath = this.cubeEvaluator.cubeFromPath(cube);
      if (cubeFromPath.refreshKey) {
        if (cubeFromPath.refreshKey.sql) {
          return [
            this.evaluateSql(cube, cubeFromPath.refreshKey.sql),
            {
              external: false,
              renewalThreshold: cubeFromPath.refreshKey.every
                ? this.refreshKeyRenewalThresholdForInterval(cubeFromPath.refreshKey, false)
                : this.defaultRefreshKeyRenewalThreshold()
            },
            this
          ];
        }

        if (cubeFromPath.refreshKey.every) {
          const [sql, external, query] = this.everyRefreshKeySql(cubeFromPath.refreshKey);
          return [
            this.refreshKeySelect(sql),
            {
              external,
              renewalThreshold: this.refreshKeyRenewalThresholdForInterval(cubeFromPath.refreshKey)
            },
            query
          ];
        }
      }

      const [sql, external, query] = this.everyRefreshKeySql(this.defaultEveryRefreshKey());
      return [
        this.refreshKeySelect(sql),
        {
          external,
          renewalThreshold: this.defaultRefreshKeyRenewalThreshold()
        },
        query
      ];
    };

    return cubes.map(cube => [cube, refreshKeyQueryByCube(cube)])
      .map(([cube, refreshKeyTuple]) => (transformFn ? transformFn(cube, refreshKeyTuple) : refreshKeyTuple))
      .map(([sql, options, query]) => query.paramAllocator.buildSqlAndParams(sql).concat(options));
  }

  aggSelectForDimension(cube, dimension, aggFunction) {
    const cubeNamesForTimeDimension = this.collectFrom(
      [dimension],
      this.collectCubeNamesFor.bind(this),
      'collectCubeNamesFor'
    );
    if (cubeNamesForTimeDimension.length === 1 && cubeNamesForTimeDimension[0] === cube) {
      const dimensionSql = this.dimensionSql(dimension);
      return `select ${aggFunction}(${this.convertTz(dimensionSql)}) from ${this.cubeSql(cube)} ${this.asSyntaxTable} ${this.cubeAlias(cube)}`;
    }

    // Handle case that requires joins
    const subQuery = this.newSubQuery({
      dimensions: [dimension.dimension],
      rowLimit: null,
    });

    const dimensionSql = subQuery.dimensionSql(dimension);
    const fromClause = subQuery.query();

    return `select ${aggFunction}(${subQuery.convertTz(dimensionSql)}) from ${fromClause}`;
  }

  cubeCardinalityQueries() { // TODO collect sub queries
    return R.fromPairs(this.allCubeNames
      .map(cube => [
        cube,
        this.paramAllocator.buildSqlAndParams(`select count(*) as ${this.escapeColumnName('total_count')} from ${this.cubeSql(cube)} ${this.asSyntaxTable} ${this.cubeAlias(cube)}`)
      ]));
  }

  renewalThreshold(refreshKeyAllSetManually) {
    return refreshKeyAllSetManually ? 24 * 60 * 60 : 6 * 60 * 60;
  }

  nowTimestampSql() {
    return 'NOW()';
  }

  unixTimestampSql() {
    return `EXTRACT(EPOCH FROM ${this.nowTimestampSql()})`;
  }

  preAggregationTableName(cube, preAggregationName, skipSchema) {
    const tblName = this.aliasName(`${cube}.${preAggregationName}`, true);
    return `${skipSchema ? '' : this.preAggregationSchema() && `${this.preAggregationSchema()}.`}${tblName}`;
  }

  preAggregationSchema() {
    return this.preAggregationsSchemaOption;
  }

  preAggregationLoadSql(cube, preAggregation, tableName) {
    const sqlAndParams = this.preAggregationSql(cube, preAggregation);
    return [`CREATE TABLE ${tableName} ${this.asSyntaxTable} ${sqlAndParams[0]}`, sqlAndParams[1]];
  }

  preAggregationPreviewSql(tableName) {
    return this.paramAllocator.buildSqlAndParams(`SELECT * FROM ${tableName} LIMIT 1000`);
  }

  indexSql(cube, preAggregation, index, indexName, tableName) {
    if (preAggregation.external && this.externalQueryClass) {
      return this.externalQuery().indexSql(cube, preAggregation, index, indexName, tableName);
    }

    if (index.columns) {
      const escapedColumns = this.evaluateIndexColumns(cube, index);
      return this.paramAllocator.buildSqlAndParams(this.createIndexSql(indexName, tableName, escapedColumns));
    } else {
      throw new Error('Index SQL support is not implemented');
    }
  }

  evaluateIndexColumns(cube, index) {
    const columns = this.cubeEvaluator.evaluateReferences(cube, index.columns, { originalSorting: true });
    return columns.map(column => {
      const path = column.split('.');
      if (path[0] &&
        this.cubeEvaluator.cubeExists(path[0]) &&
        (
          this.cubeEvaluator.isMeasure(path) ||
          this.cubeEvaluator.isDimension(path) ||
          this.cubeEvaluator.isSegment(path)
        )
      ) {
        if (path.length === 3 && this.cubeEvaluator.isDimension(path.slice(0, 2))) {
          const dimensionDef = this.cubeEvaluator.dimensionByPath(path.slice(0, 2));
          if (dimensionDef.type === 'time' &&
            this.cubeEvaluator.resolveGranularity([path[0], path[1], 'granularities', path[2]])) {
            const td = this.newTimeDimension({
              dimension: `${path[0]}.${path[1]}`,
              granularity: path[2],
            });
            return td.unescapedAliasName();
          }
        }
        return this.aliasName(column);
      } else {
        return column;
      }
    }).map(c => this.escapeColumnName(c));
  }

  createIndexSql(indexName, tableName, escapedColumns) {
    return `CREATE INDEX ${indexName} ON ${tableName} (${escapedColumns.join(', ')})`;
  }

  preAggregationSql(cube, preAggregation) {
    return this.cacheValue(
      ['preAggregationSql', cube, JSON.stringify(preAggregation)],
      () => {
        const { collectOriginalSqlPreAggregations } = this.safeEvaluateSymbolContext();
        if (preAggregation.type === 'autoRollup') {
          const query = this.preAggregations.autoRollupPreAggregationQuery(cube, preAggregation);
          return query.evaluateSymbolSqlWithContext(() => query.buildSqlAndParams(), {
            collectOriginalSqlPreAggregations
          });
        } else if (preAggregation.type === 'rollup') {
          const query = this.preAggregations.rollupPreAggregationQuery(cube, preAggregation);
          return query.evaluateSymbolSqlWithContext(() => query.buildSqlAndParams(), {
            collectOriginalSqlPreAggregations
          });
        } else if (preAggregation.type === 'originalSql') {
          const originalSqlPreAggregationQuery = this.preAggregations.originalSqlPreAggregationQuery(
            cube,
            preAggregation
          );
          const cubeFromPath = this.cubeEvaluator.cubeFromPath(cube);
          return this.paramAllocator.buildSqlAndParams(originalSqlPreAggregationQuery.evaluateSymbolSqlWithContext(
            () => {
              if (cubeFromPath.sqlTable) {
                return `SELECT * FROM ${originalSqlPreAggregationQuery.cubeSql(cube)}`;
              }
              return originalSqlPreAggregationQuery.evaluateSql(cube, cubeFromPath.sql);
            },
            { preAggregationQuery: true, collectOriginalSqlPreAggregations }
          ));
        }
        throw new UserError(`Unknown pre-aggregation type '${preAggregation.type}' in '${cube}'`);
      },
      { inputProps: { collectOriginalSqlPreAggregations: [] }, cache: this.queryCache }
    );
  }

  preAggregationOutputColumnTypes(cube, preAggregation) {
    return this.cacheValue(
      ['preAggregationOutputColumnTypes', cube, JSON.stringify(preAggregation)],
      () => {
        if (!preAggregation.outputColumnTypes) {
          return null;
        }

        if (preAggregation.type === 'rollup') {
          const query = this.preAggregations.rollupPreAggregationQuery(cube, preAggregation);

          const evaluatedMapOutputColumnTypes = preAggregation.outputColumnTypes.reduce((acc, outputColumnType) => {
            acc.set(outputColumnType.name, outputColumnType);
            return acc;
          }, new Map());

          const findSchemaType = member => {
            const outputSchemaType = evaluatedMapOutputColumnTypes.get(member);
            if (!outputSchemaType) {
              throw new UserError(`Output schema type for ${member} not found in pre-aggregation ${preAggregation}`);
            }

            return {
              name: this.aliasName(member),
              type: outputSchemaType.type,
            };
          };

          // The order of the output columns is important, it should match the order in the select statement
          const outputColumnTypes = [
            ...(query.dimensions || []).map(d => findSchemaType(d.dimension)),
            ...(query.timeDimensions || []).map(t => ({
              name: `${this.aliasName(t.dimension)}_${t.granularity}`,
              type: 'TIMESTAMP'
            })),
            ...(query.measures || []).map(m => findSchemaType(m.measure)),
          ];

          return outputColumnTypes;
        }
        throw new UserError('Output schema is only supported for rollup pre-aggregations');
      },
      { inputProps: {}, cache: this.queryCache }
    );
  }

  preAggregationUniqueKeyColumns(cube, preAggregation) {
    if (preAggregation.uniqueKeyColumns) {
      return preAggregation.uniqueKeyColumns.map(key => this.aliasName(`${cube}.${key}`));
    }

    return this.dimensionColumns();
  }

  preAggregationReadOnly(_cube, _preAggregation) {
    return false;
  }

  preAggregationAllowUngroupingWithPrimaryKey(_cube, _preAggregation) {
    return false;
  }

  /**
   * @public
   * @returns {any}
   */
  sqlTemplates() {
    return {
      functions: {
        SUM: 'SUM({{ args_concat }})',
        MIN: 'MIN({{ args_concat }})',
        MAX: 'MAX({{ args_concat }})',
        COUNT: 'COUNT({{ args_concat }})',
        COUNT_DISTINCT: 'COUNT(DISTINCT {{ args_concat }})',
        AVG: 'AVG({{ args_concat }})',
        STDDEV_POP: 'STDDEV_POP({{ args_concat }})',
        STDDEV_SAMP: 'STDDEV_SAMP({{ args_concat }})',
        VAR_POP: 'VAR_POP({{ args_concat }})',
        VAR_SAMP: 'VAR_SAMP({{ args_concat }})',
        COVAR_POP: 'COVAR_POP({{ args_concat }})',
        COVAR_SAMP: 'COVAR_SAMP({{ args_concat }})',
        GROUP_ANY: 'max({{ expr }})',
        STRING_AGG: 'STRING_AGG({% if distinct %}DISTINCT {% endif %}{{ args_concat }})',
        COALESCE: 'COALESCE({{ args_concat }})',
        CONCAT: 'CONCAT({{ args_concat }})',
        FLOOR: 'FLOOR({{ args_concat }})',
        CEIL: 'CEIL({{ args_concat }})',
        TRUNC: 'TRUNC({{ args_concat }})',
        LAG: 'LAG({{ args_concat }})',
        LEAD: 'LEAD({{ args_concat }})',

        // There is a difference in behaviour of these function processing in different DBs and DWHs.
        // The SQL standard requires greatest and least to return null in case one argument is null.
        // However, many DBMS ignore NULL values (mostly because greatest and least were often supported
        // decades before they were added to the SQL standard in 2023).
        // Cube follows the Postgres implementation (as we mimic the Postgres protocol) and ignores NULL values.
        // So these functions are enabled on a driver-specific basis for databases that ignores NULLs.
        // LEAST: 'LEAST({{ args_concat }})',
        // GREATEST: 'GREATEST({{ args_concat }})',

        LOWER: 'LOWER({{ args_concat }})',
        UPPER: 'UPPER({{ args_concat }})',
        LEFT: 'LEFT({{ args_concat }})',
        RIGHT: 'RIGHT({{ args_concat }})',
        SQRT: 'SQRT({{ args_concat }})',
        ABS: 'ABS({{ args_concat }})',
        ACOS: 'ACOS({{ args_concat }})',
        ASIN: 'ASIN({{ args_concat }})',
        ATAN: 'ATAN({{ args_concat }})',
        COS: 'COS({{ args_concat }})',
        EXP: 'EXP({{ args_concat }})',
        LN: 'LN({{ args_concat }})',
        LOG: 'LOG({{ args_concat }})',
        DLOG10: 'LOG10({{ args_concat }})',
        PI: 'PI()',
        POWER: 'POWER({{ args_concat }})',
        SIN: 'SIN({{ args_concat }})',
        TAN: 'TAN({{ args_concat }})',
        REPEAT: 'REPEAT({{ args_concat }})',
        NULLIF: 'NULLIF({{ args_concat }})',
        ROUND: 'ROUND({{ args_concat }})',

        STDDEV: 'STDDEV_SAMP({{ args_concat }})',
        SUBSTR: 'SUBSTRING({{ args_concat }})',
        CHARACTERLENGTH: 'CHAR_LENGTH({{ args[0] }})',

        // Non-ANSI functions
        BTRIM: 'BTRIM({{ args_concat }})',
        LTRIM: 'LTRIM({{ args_concat }})',
        RTRIM: 'RTRIM({{ args_concat }})',
        ATAN2: 'ATAN2({{ args_concat }})',
        COT: 'COT({{ args_concat }})',
        DEGREES: 'DEGREES({{ args_concat }})',
        RADIANS: 'RADIANS({{ args_concat }})',
        SIGN: 'SIGN({{ args_concat }})',
        ASCII: 'ASCII({{ args_concat }})',
        STRPOS: 'POSITION({{ args[1] }} IN {{ args[0] }})',
        REPLACE: 'REPLACE({{ args_concat }})',
        DATEDIFF: 'DATEDIFF({{ date_part }}, {{ args[1] }}, {{ args[2] }})',
        TO_CHAR: 'TO_CHAR({{ args_concat }})',
        // DATEADD is being rewritten to DATE_ADD
        // DATEADD: 'DATEADD({{ date_part }}, {{ interval }}, {{ args[2] }})',
        DATE: 'DATE({{ args_concat }})',

        PERCENTILECONT: 'PERCENTILE_CONT({{ args_concat }})',
      },
      statements: {
        select: '{% if ctes %} WITH \n' +
          '{{ ctes | join(\',\n\') }}\n' +
          '{% endif %}' +
          'SELECT {% if distinct %}DISTINCT {% endif %}' +
          '{{ select_concat | map(attribute=\'aliased\') | join(\', \') }} {% if from %}\n' +
          'FROM (\n' +
          '{{ from | indent(2, true) }}\n' +
          ') AS {{ from_alias }}{% elif from_prepared %}\n' +
          'FROM {{ from_prepared }}' +
          '{% endif %}' +
          '{% for join in joins %}\n{{ join }}{% endfor %}' +
          '{% if filter %}\nWHERE {{ filter }}{% endif %}' +
          '{% if group_by %}\nGROUP BY {{ group_by }}{% endif %}' +
          '{% if having %}\nHAVING {{ having }}{% endif %}' +
          '{% if order_by %}\nORDER BY {{ order_by | map(attribute=\'expr\') | join(\', \') }}{% endif %}' +
          '{% if limit is not none %}\nLIMIT {{ limit }}{% endif %}' +
          '{% if offset is not none %}\nOFFSET {{ offset }}{% endif %}',
        group_by_exprs: '{{ group_by | map(attribute=\'index\') | join(\', \') }}',
        join: '{{ join_type }} JOIN {{ source }} ON {{ condition }}',
        cte: '{{ alias }} AS ({{ query | indent(2, true) }})',
        time_series_select: 'SELECT date_from::timestamp AS "date_from",\n' +
          'date_to::timestamp AS "date_to" \n' +
          'FROM(\n' +
          '    VALUES ' +
          '{% for time_item in seria  %}' +
          '(\'{{ time_item | join(\'\\\', \\\'\') }}\')' +
          '{% if not loop.last %}, {% endif %}' +
          '{% endfor %}' +
          ') AS dates (date_from, date_to)',
        time_series_get_range: 'SELECT {{ max_expr }} as {{ quoted_max_name }},\n' +
          '{{ min_expr }} as {{ quoted_min_name }}\n' +
          'FROM {{ from_prepared }}\n' +
          '{% if filter %}WHERE {{ filter }}{% endif %}',
        calc_groups_join: '{% if original_sql %}{{ original_sql }}\n{% endif %}' +
        '{% for group in groups  %}' +
        '{% if original_sql or not loop.first %}CROSS JOIN\n{% endif %}' +
        '(\n' +
        '{% for value in group.values  %}' +
        'SELECT {{ value }} as {{ group.name }}' +
        '{% if not loop.last %} UNION ALL\n{% endif %}' +
        '{% endfor %}' +
        ') AS {{ group.alias }}\n' +
        '{% endfor %}'
      },
      expressions: {
        column_reference: '{% if table_name %}{{ table_name }}.{% endif %}{{ name }}',
        column_aliased: '{{expr}} {{quoted_alias}}',
        query_aliased: '{{ query }} AS {{ quoted_alias }}',
        case: 'CASE{% if expr %} {{ expr }}{% endif %}{% for when, then in when_then %} WHEN {{ when }} THEN {{ then }}{% endfor %}{% if else_expr %} ELSE {{ else_expr }}{% endif %} END',
        is_null: '({{ expr }} IS {% if negate %}NOT {% endif %}NULL)',
        binary: '({{ left }} {{ op }} {{ right }})',
        sort: '{{ expr }} {% if asc %}ASC{% else %}DESC{% endif %} NULLS {% if nulls_first %}FIRST{% else %}LAST{% endif %}',
        // Note: Tesseract/Rust SQL generation renders ORDER BY via this template without passing
        // `nulls_first`, so NULL handling must be unconditional here for PG-like dialects.
        // MySQL dialect overrides this template to avoid `NULLS FIRST/LAST` incompatibilities.
        order_by: '{% if index %} {{ index }} {% else %} {{ expr }} {% endif %} {% if asc %}ASC NULLS FIRST{% else %}DESC NULLS LAST{% endif %}',
        cast: 'CAST({{ expr }} AS {{ data_type }})',
        window_function: '{{ fun_call }} OVER ({% if partition_by_concat %}PARTITION BY {{ partition_by_concat }}{% if order_by_concat or window_frame %} {% endif %}{% endif %}{% if order_by_concat %}ORDER BY {{ order_by_concat }}{% if window_frame %} {% endif %}{% endif %}{% if window_frame %}{{ window_frame }}{% endif %})',
        window_frame_bounds: '{{ frame_type }} BETWEEN {{ frame_start }} AND {{ frame_end }}',
        in_list: '{{ expr }} {% if negated %}NOT {% endif %}IN ({{ in_exprs_concat }})',
        subquery: '({{ expr }})',
        in_subquery: '{{ expr }} {% if negated %}NOT {% endif %}IN {{ subquery_expr }}',
        rollup: 'ROLLUP({{ exprs_concat }})',
        cube: 'CUBE({{ exprs_concat }})',
        negative: '-({{ expr }})',
        not: 'NOT ({{ expr }})',
        add_interval: '{{ date }} + interval \'{{ interval }}\'',
        sub_interval: '{{ date }} - interval \'{{ interval }}\'',
        true: 'TRUE',
        false: 'FALSE',
        like: '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}',
        ilike: '{{ expr }} {% if negated %}NOT {% endif %}ILIKE {{ pattern }}',
        like_escape: '{{ like_expr }} ESCAPE {{ escape_char }}',
        within_group: '{{ fun_sql }} WITHIN GROUP (ORDER BY {{ within_group_concat }})',
        concat_strings: '{{ strings | join(\' || \' ) }}',
        wrap_segment_select: '{{ expr }}',
        wrap_segment_filter: '{{ expr }}',
        rolling_window_expr_timestamp_cast: '{{ value }}',
        timestamp_literal: '{{ value }}',
        between: '{{ expr }} {% if negated %}NOT {% endif %}BETWEEN {{ low }} AND {{ high }}',
      },
      tesseract: {
        ilike: '{{ expr }} {% if negated %}NOT {% endif %}ILIKE {{ pattern }}', // May require different overloads in Tesseract than the ilike from expressions used in SQLAPI.
        series_bounds_cast: '{{ expr }}',
        bool_param_cast: '{{ expr }}',
        number_param_cast: '{{ expr }}',
        // Tesseract uses its own join type templates, decoupled from `join_types`
        // which are used by the SQL API push down. FULL is opt-in per dialect.
        join_types_inner: 'INNER',
        join_types_left: 'LEFT',
      },
      filters: {
        equals: '{{ column }} = {{ value }}{{ is_null_check }}',
        not_equals: '{{ column }} <> {{ value }}{{ is_null_check }}',
        or_is_null_check: ' OR {{ column }} IS NULL',
        set_where: '{{ column }} IS NOT NULL',
        not_set_where: '{{ column }} IS NULL',
        in: '{{ column }} IN ({{ values_concat }}){{ is_null_check }}',
        not_in: '{{ column }} NOT IN ({{ values_concat }}){{ is_null_check }}',
        time_range_filter: '{{ column }} >= {{ from_timestamp }} AND {{ column }} <= {{ to_timestamp }}',
        time_not_in_range_filter: '{{ column }} < {{ from_timestamp }} OR {{ column }} > {{ to_timestamp }}',
        gt: '{{ column }} > {{ param }}',
        gte: '{{ column }} >= {{ param }}',
        lt: '{{ column }} < {{ param }}',
        lte: '{{ column }} <= {{ param }}',
        like_pattern: '{% if start_wild %}\'%\' || {% endif %}{{ value }}{% if end_wild %}|| \'%\'{% endif %}',
        always_true: '1 = 1'

      },
      operators: {},
      quotes: {
        identifiers: '"',
        escape: '""'
      },
      params: {
        param: '?'
      },
      join_types: {
        inner: 'INNER',
        left: 'LEFT',
        right: 'RIGHT',
        full: 'FULL',
      },
      window_frame_types: {
        rows: 'ROWS',
        range: 'RANGE',
      },
      window_frame_bounds: {
        preceding: '{% if n is not none %}{{ n }}{% else %}UNBOUNDED{% endif %} PRECEDING',
        current_row: 'CURRENT ROW',
        following: '{% if n is not none %}{{ n }}{% else %}UNBOUNDED{% endif %} FOLLOWING',
      },
      types: {
        string: 'STRING',
        boolean: 'BOOLEAN',
        tinyint: 'TINYINT',
        smallint: 'SMALLINT',
        integer: 'INTEGER',
        bigint: 'BIGINT',
        float: 'FLOAT',
        double: 'DOUBLE',
        decimal: 'DECIMAL({{ precision }},{{ scale }})',
        timestamp: 'TIMESTAMP',
        date: 'DATE',
        time: 'TIME',
        interval: 'INTERVAL',
        binary: 'BINARY',
      },
    };
  }

  /**
   *
   * @param cube
   * @param preAggregation
   * @returns {BaseQuery}
   */
  // eslint-disable-next-line consistent-return
  preAggregationQueryForSqlEvaluation(cube, preAggregation, context = {}) {
    if (preAggregation.type === 'autoRollup') {
      return this.preAggregations.autoRollupPreAggregationQuery(cube, preAggregation);
    } else if (preAggregation.type === 'rollup') {
      return this.preAggregations.rollupPreAggregationQuery(cube, preAggregation, context);
    } else if (preAggregation.type === 'originalSql') {
      return this;
    }
  }

  parseCronSyntax(every) {
    // Use the Unix epoch as the reference point for calculating dayOffset.
    // The refresh key SQL formula is: FLOOR((unix_timestamp - dayOffset) / interval)
    // Since Unix timestamps are measured from Thu, 01 Jan 1970 00:00:00 UTC,
    // week boundaries naturally fall on Thursdays when dividing by 604800 (1 week).
    // By calculating dayOffset from the epoch to the first cron fire time,
    // we correctly shift the boundaries to align with the desired day of week.
    const opt = {
      utc: true,
      currentDate: new Date(0) // Unix epoch
    };

    try {
      const interval = cronParser.parseExpression(every, opt);
      let dayOffset = interval.next().getTime();
      const dayOffsetPrev = interval.prev().getTime();

      // If the cron fires exactly at the epoch, use 0 as dayOffset
      if (dayOffsetPrev === 0) {
        dayOffset = 0;
      }

      return {
        start: interval.next(),
        end: interval.next(),
        dayOffset: dayOffset / 1000, // Convert from ms to seconds
      };
    } catch (err) {
      throw new UserError(`Invalid cron string '${every}' in refreshKey (${err})`);
    }
  }

  calcIntervalForCronString(refreshKey) {
    const every = refreshKey.every || '1 hour';

    const { start, end, dayOffset } = this.parseCronSyntax(every);

    const interval = (end.getTime() - start.getTime()) / 1000;

    if (
      !/^(\*|\d+)? ?(\*|\d+) (\*|\d+) \* \* (\*|\d+)$/g.test(every.replace(/ +/g, ' ').replace(/^ | $/g, ''))
    ) {
      throw new UserError(`Your cron string ('${every}') is correct, but we support only equal time intervals.`);
    }

    let utcOffset = 0;

    if (refreshKey.timezone || this.timezone) {
      utcOffset = moment.tz(refreshKey.timezone).utcOffset() * 60;
    }

    return {
      utcOffset,
      interval,
      dayOffset,
    };
  }

  everyRefreshKeySql(refreshKey, external = false) {
    if (this.externalQueryClass) {
      return this.externalQuery().everyRefreshKeySql(refreshKey, true);
    }

    const every = refreshKey.every || '1 hour';

    if (/^(\d+) (second|minute|hour|day|week)s?$/.test(every)) {
      const utcOffset = this.timezone ? moment.tz(this.timezone).utcOffset() * 60 : 0;
      const utcOffsetPrefix = utcOffset ? `${utcOffset} + ` : '';
      return [this.floorSql(`(${utcOffsetPrefix}${this.unixTimestampSql()}) / ${this.parseSecondDuration(every)}`), external, this];
    }

    const { dayOffset, utcOffset, interval } = this.calcIntervalForCronString(refreshKey);

    /**
     * Small explanation how it works for every `0 8 * * *`
     * 28800 is a $dayOffset
     *
     * SELECT ((3600 * 8 - 28800) / 86400); -- 0
     * SELECT ((3600 * 16 - 28800) / 86400); -- 0
     * SELECT ((3600 * 24 - 28800) / 86400); -- 0
     * SELECT ((3600 * (24 + 8) - 28800) / 86400); -- 1
     * SELECT ((3600 * (48 + 8) - 28800) / 86400); -- 2
     */
    return [this.floorSql(`(${utcOffset} + ${this.unixTimestampSql()} - ${dayOffset}) / ${interval}`), external, this];
  }

  granularityFor(momentDate) {
    const obj = momentDate.toObject();
    const weekDay = momentDate.isoWeekday();
    if (
      obj.months === 0 &&
      obj.date === 1 &&
      obj.hours === 0 &&
      obj.minutes === 0 &&
      obj.seconds === 0 &&
      obj.milliseconds === 0
    ) {
      return 'year';
    } else if (
      obj.date === 1 &&
      obj.hours === 0 &&
      obj.minutes === 0 &&
      obj.seconds === 0 &&
      obj.milliseconds === 0
    ) {
      return 'month';
    } else if (
      weekDay === 1 &&
      obj.hours === 0 &&
      obj.minutes === 0 &&
      obj.seconds === 0 &&
      obj.milliseconds === 0
    ) {
      return 'week';
    } else if (
      obj.hours === 0 &&
      obj.minutes === 0 &&
      obj.seconds === 0 &&
      obj.milliseconds === 0
    ) {
      return 'day';
    } else if (
      obj.minutes === 0 &&
      obj.seconds === 0 &&
      obj.milliseconds === 0
    ) {
      return 'hour';
    } else if (
      obj.seconds === 0 &&
      obj.milliseconds === 0
    ) {
      return 'minute';
    } else if (
      obj.milliseconds === 0
    ) {
      return 'second';
    }
    return 'second'; // TODO return 'millisecond';
  }

  /**
   * @protected
   * @param {string} interval
   * @return {[number, string]}
   */
  parseInterval(interval) {
    const intervalMatch = interval.match(/^(-?\d+) (second|minute|hour|day|week|month|quarter|year)s?$/);
    if (!intervalMatch) {
      throw new UserError(`Invalid interval: ${interval}`);
    }

    const duration = parseInt(intervalMatch[1], 10);

    return [duration, intervalMatch[2]];
  }

  negateInterval(interval) {
    const [duration, grunularity] = this.parseInterval(interval);

    return `${duration * -1} ${grunularity}`;
  }

  parseSecondDuration(interval) {
    const [duration, type] = this.parseInterval(interval);

    const secondsInInterval = SecondsDurations[type];
    return secondsInInterval * duration;
  }

  floorSql(numeric) {
    return `FLOOR(${numeric})`;
  }

  incrementalRefreshKey(query, originalRefreshKey, options = {}) {
    const refreshKeyQuery = options.refreshKeyQuery || query;
    const updateWindow = options.window;
    const timeDimension = query.timeDimensions[0];

    // TODO use timeDimension from refreshKeyQuery directly
    const dateTo = refreshKeyQuery.timeStampCast(refreshKeyQuery.paramAllocator.allocateParam(timeDimension.dateTo()));
    return refreshKeyQuery.caseWhenStatement([{
      sql: `${refreshKeyQuery.nowTimestampSql()} < ${updateWindow ?
        refreshKeyQuery.addTimestampInterval(dateTo, updateWindow) :
        dateTo
      }`,
      label: originalRefreshKey
    }]);
  }

  defaultRefreshKeyRenewalThreshold() {
    return 10;
  }

  defaultEveryRefreshKey() {
    return {
      every: '10 seconds'
    };
  }

  /**
   * Some databases can return dynamically column name, for example Cube Store
   *
   * SELECT FLOOR((UNIX_TIMESTAMP()) / 60);
   * +-------------------------------------------+
   * | floor(Int64(1625395697) Divide Int64(60)) |
   * +-------------------------------------------+
   * | 27089928                                  |
   * +-------------------------------------------+
   * 1 row in set (0.00 sec)
   *
   * @protected
   *
   * @param {string} sql
   * @return {string}
   */
  refreshKeySelect(sql) {
    return `SELECT ${sql} as refresh_key`;
  }

  partitionInvalidateKeyQueries(_cube, _preAggregation) {
    // this is not used across all dialects, atm only in KsqlQuery.
  }

  preAggregationInvalidateKeyQueries(cube, preAggregation, preAggregationName) {
    return this.cacheValue(
      ['preAggregationInvalidateKeyQueries', cube, JSON.stringify(preAggregation)],
      () => {
        const preAggregationQueryForSql = this.preAggregationQueryForSqlEvaluation(cube, preAggregation);
        if (preAggregation.refreshKey) {
          if (preAggregation.refreshKey.sql) {
            return [
              preAggregationQueryForSql.paramAllocator.buildSqlAndParams(
                preAggregationQueryForSql.evaluateSql(cube, preAggregation.refreshKey.sql)
              ).concat({
                external: false,
                renewalThreshold: preAggregation.refreshKey.every
                  ? this.refreshKeyRenewalThresholdForInterval(preAggregation.refreshKey, false)
                  : this.defaultRefreshKeyRenewalThreshold(),
              })
            ];
          }

          // eslint-disable-next-line prefer-const
          let [refreshKey, refreshKeyExternal, refreshKeyQuery] = this.everyRefreshKeySql(preAggregation.refreshKey);
          const renewalThreshold = this.refreshKeyRenewalThresholdForInterval(preAggregation.refreshKey);
          if (preAggregation.refreshKey.incremental) {
            if (!preAggregation.partitionGranularity) {
              throw new UserError(`Incremental refresh key can only be used for partitioned pre-aggregations but set for non-partitioned '${cube}.${preAggregationName}'`);
            }
            // TODO Case when partitioned originalSql is resolved for query without time dimension.
            // Consider fallback to not using such originalSql for consistency?
            if (
              preAggregationQueryForSql.timeDimensions.length &&
              preAggregationQueryForSql.timeDimensions[0].dateRange
            ) {
              refreshKey = this.incrementalRefreshKey(
                preAggregationQueryForSql,
                refreshKey,
                { window: preAggregation.refreshKey.updateWindow, refreshKeyQuery }
              );
            }
          }

          if (preAggregation.refreshKey.every || preAggregation.refreshKey.incremental) {
            return [
              refreshKeyQuery.paramAllocator.buildSqlAndParams(this.refreshKeySelect(refreshKey)).concat({
                external: refreshKeyExternal,
                renewalThreshold,
                incremental: preAggregation.refreshKey.incremental,
                updateWindowSeconds: preAggregation.refreshKey.updateWindow &&
                  this.parseSecondDuration(preAggregation.refreshKey.updateWindow),
                renewalThresholdOutsideUpdateWindow: preAggregation.refreshKey.incremental &&
                  24 * 60 * 60
              })
            ];
          }
        }

        if (preAggregation.type === 'originalSql') {
          return this.evaluateSymbolSqlWithContext(
            () => this.refreshKeysByCubes([cube]),
            { preAggregationQuery: true }
          );
        }

        if (
          !preAggregationQueryForSql.allCubeNames.find(c => {
            const fromPath = this.cubeEvaluator.cubeFromPath(c);
            return fromPath.refreshKey && fromPath.refreshKey.sql;
          })
        ) {
          const cubeFromPath = this.cubeEvaluator.cubeFromPath(cube);
          return preAggregationQueryForSql.evaluateSymbolSqlWithContext(
            () => preAggregationQueryForSql.cacheKeyQueries(
              (refreshKeyCube, [refreshKeySQL, refreshKeyQueryOptions, refreshKeyQuery]) => {
                if (!cubeFromPath.refreshKey) {
                  const [sql, external, query] = this.everyRefreshKeySql({
                    every: '1 hour'
                  });

                  return [
                    this.refreshKeySelect(sql),
                    {
                      external,
                      renewalThreshold: this.defaultRefreshKeyRenewalThreshold(),
                    },
                    query
                  ];
                }

                return [refreshKeySQL, refreshKeyQueryOptions, refreshKeyQuery];
              }
            ),
            { preAggregationQuery: true }
          );
        }

        return preAggregationQueryForSql.evaluateSymbolSqlWithContext(
          () => preAggregationQueryForSql.cacheKeyQueries(),
          { preAggregationQuery: true }
        );
      },
      { inputProps: { collectOriginalSqlPreAggregations: [] }, cache: this.queryCache }
    );
  }

  refreshKeyRenewalThresholdForInterval(refreshKey, everyWithoutSql = true) {
    const { every } = refreshKey;

    if (/^(\d+) (second|minute|hour|day|week)s?$/.test(every)) {
      const threshold = Math.max(Math.round(this.parseSecondDuration(every) / (everyWithoutSql ? 10 : 1)), 1);

      if (everyWithoutSql) {
        return Math.min(threshold, 300);
      }

      return threshold;
    }

    const { interval } = this.calcIntervalForCronString(refreshKey);
    const threshold = Math.max(Math.round(interval / (everyWithoutSql ? 10 : 1)), 1);

    if (everyWithoutSql) {
      return Math.min(threshold, 300);
    }

    return threshold;
  }

  preAggregationStartEndQueries(cube, preAggregation) {
    const references = this.cubeEvaluator.evaluatePreAggregationReferences(cube, preAggregation);
    const timeDimension = this.newTimeDimension(references.timeDimensions[0]);

    return this.evaluateSymbolSqlWithContext(() => [
      this.paramAllocator.buildSqlAndParams(
        preAggregation.refreshRangeStart && this.evaluateSql(cube, preAggregation.refreshRangeStart.sql) ||
        this.aggSelectForDimension(timeDimension.path()[0], timeDimension, 'min')
      ),
      this.paramAllocator.buildSqlAndParams(
        preAggregation.refreshRangeEnd && this.evaluateSql(cube, preAggregation.refreshRangeEnd.sql) ||
        this.aggSelectForDimension(timeDimension.path()[0], timeDimension, 'max')
      )
    ], { preAggregationQuery: true });
  }

  parametrizedContextSymbols() {
    if (!this.parametrizedContextSymbolsValue) {
      this.parametrizedContextSymbolsValue = Object.assign({
        filterParams: this.filtersProxy(),
        filterGroup: this.filterGroupFunction(),
        sqlUtils: {
          convertTz: this.convertTz.bind(this),
          urlEncode: this.urlEncode.bind(this)
        }
      }, R.map(
        (symbols) => this.contextSymbolsProxy(symbols),
        this.contextSymbols
      ));
    }
    return this.parametrizedContextSymbolsValue;
  }

  static emptyParametrizedContextSymbols(cubeEvaluator, allocateParam) {
    return {
      filterParams: BaseQuery.filterProxyFromAllFilters(null, cubeEvaluator, allocateParam, (filter) => new BaseGroupFilter(filter)),
      filterGroup: () => '1 = 1',
      sqlUtils: {
        convertTz: (field) => field,
        urlEncode: (sql) => sql,
      },
      securityContext: CubeSymbols.contextSymbolsProxyFrom({}, allocateParam),
    };
  }

  securityContextForRust() {
    return this.contextSymbolsProxy(this.contextSymbols.securityContext);
  }

  sqlUtilsForRust() {
    return {
      convertTz: this.convertTz.bind(this),
      urlEncode: this.urlEncode.bind(this)
    };
  }

  // Invoked from the native planner to compile a member's `sql` function: runs
  // it under recording proxies and returns the produced template plus the
  // dependencies it touched. The recording logic is a standalone, stateless
  // module so it can be unit-tested in isolation.
  compileMemberSql(sqlFn, securityContext, argNames) {
    // eslint-disable-next-line global-require
    const { compileMemberSql } = require('./MemberSqlTemplateCompiler');
    return compileMemberSql(sqlFn, argNames, securityContext, this.sqlUtilsForRust());
  }

  contextSymbolsProxy(symbols) {
    return CubeSymbols.contextSymbolsProxyFrom(symbols, this.paramAllocator.allocateParam.bind(this.paramAllocator));
  }

  static extractFilterMembers(filter) {
    if (filter.operator === 'and' || filter.operator === 'or') {
      return filter.values.map(f => BaseQuery.extractFilterMembers(f)).reduce((a, b) => ((a && b) ? { ...a, ...b } : null), {});
    } else if (filter.measure) {
      return {
        [filter.measure]: true
      };
    } else if (filter.dimension) {
      return {
        [filter.dimension]: true
      };
    } else {
      return null;
    }
  }

  static findAndSubTreeForFilterGroup(filter, groupMembers, newGroupFilter, aliases) {
    if ((filter.operator === 'and' || filter.operator === 'or') && !filter.values?.length) {
      return null;
    }
    const filterMembers = BaseQuery.extractFilterMembers(filter);
    if (filterMembers && Object.keys(filterMembers).every(m => (groupMembers.indexOf(m) !== -1 || aliases.indexOf(m) !== -1))) {
      return filter;
    }
    if (filter.operator === 'and') {
      const result = filter.values.map(f => BaseQuery.findAndSubTreeForFilterGroup(f, groupMembers, newGroupFilter, aliases)).filter(f => !!f);
      if (!result.length) {
        return null;
      }
      if (result.length === 1) {
        return result[0];
      }
      return newGroupFilter({
        operator: 'and',
        values: result
      });
    }
    return null;
  }

  filtersProxy() {
    const { allFilters } = this;
    return BaseQuery.filterProxyFromAllFilters(
      allFilters,
      this.cubeEvaluator,
      this.paramAllocator.allocateParam.bind(this.paramAllocator),
      this.newGroupFilter.bind(this),
    );
  }

  filtersProxyForRust(usedFilters) {
    const filters = this.extractFiltersAsTree(usedFilters || []);
    const allFilters = filters.map(this.initFilter.bind(this));
    return BaseQuery.filterProxyFromAllFilters(
      allFilters,
      this.cubeEvaluator,
      this.paramAllocator.allocateParam.bind(this.paramAllocator),
      this.newGroupFilter.bind(this),
    );
  }

  filterGroupFunctionForRust(usedFilters) {
    const filters = this.extractFiltersAsTree(usedFilters || []);
    const allFilters = filters.map(this.initFilter.bind(this));
    return this.filterGroupFunctionImpl(allFilters);
  }

  static renderFilterParams(filter, filterParamArgs, allocateParam, newGroupFilter, aliases) {
    if (!filter) {
      return BaseFilter.ALWAYS_TRUE;
    }

    if (filter.operator === 'and' || filter.operator === 'or') {
      const values = filter.values
        .map(f => BaseQuery.renderFilterParams(f, filterParamArgs, allocateParam, newGroupFilter, aliases))
        .map(v => ({ filterToWhere: () => v }));

      return newGroupFilter({ operator: filter.operator, values }).filterToWhere();
    }

    const filterParams = filter.filterParams();
    const filterParamArg = filterParamArgs.filter(p => {
      const member = p.__member();
      return member === filter.measure ||
        member === filter.dimension ||
        (aliases[member] && (
          aliases[member] === filter.measure ||
          aliases[member] === filter.dimension
        ));
    })[0];

    if (!filterParamArg) {
      throw new Error(`FILTER_PARAMS arg not found for ${filter.measure || filter.dimension}`);
    }

    if (typeof filterParamArg.__column() !== 'function') {
      return filter.conditionSql(filterParamArg.__column());
    }

    if (!filterParams || !filterParams.length) {
      return BaseFilter.ALWAYS_TRUE;
    }

    // eslint-disable-next-line prefer-spread
    return filterParamArg.__column().apply(
      null,
      filterParams.map(allocateParam),
    );
  }

  filterGroupFunction() {
    const { allFilters } = this;
    return this.filterGroupFunctionImpl(allFilters);
  }

  filterGroupFunctionImpl(allFilters) {
    const allocateParam = this.paramAllocator.allocateParam.bind(this.paramAllocator);
    const newGroupFilter = this.newGroupFilter.bind(this);
    return (...filterParamArgs) => {
      const groupMembers = filterParamArgs.map(f => {
        if (!f.__member) {
          throw new UserError(`FILTER_GROUP expects FILTER_PARAMS args to be passed. For example FILTER_GROUP(FILTER_PARAMS.foo.bar.filter('bar'), FILTER_PARAMS.foo.jar.filter('jar')). But found: ${f}`);
        }
        return f.__member();
      });

      const aliases = allFilters ?
        allFilters
          .map(v => (v.query ? v.query.allBackAliasMembersExceptSegments() : {}))
          .reduce((a, b) => ({ ...a, ...b }), {})
        : {};
      // Filtering aliases that somehow relate to this group members
      const aliasesForGroupMembers = Object.entries(aliases)
        .filter(([key, value]) => groupMembers.includes(key))
        .map(([_key, value]) => value);
      const filter = BaseQuery.findAndSubTreeForFilterGroup(
        newGroupFilter({ operator: 'and', values: allFilters }),
        groupMembers,
        newGroupFilter,
        aliasesForGroupMembers
      );

      return `(${BaseQuery.renderFilterParams(filter, filterParamArgs, allocateParam, newGroupFilter, aliases)})`;
    };
  }

  static filterProxyFromAllFilters(allFilters, cubeEvaluator, allocateParam, newGroupFilter) {
    return new Proxy({}, {
      get: (_target, name) => {
        if (name === '_objectWithResolvedProperties') {
          return true;
        }
        // allFilters is null whenever it's used to test if the member is owned by cube so it should always render to `1 = 1`
        // and do not check cube validity as it's part of compilation step.
        const cubeName = allFilters && cubeEvaluator.cubeNameFromPath(name);
        return new Proxy({ cube: cubeName }, {
          get: (cubeNameObj, propertyName) => ({
            filter: (column) => ({
              __column() {
                return column;
              },
              __member() {
                return cubeEvaluator.pathFromArray([cubeNameObj.cube, propertyName]);
              },
              toString() {
                // Segments should be excluded because they are evaluated separately in cubeReferenceProxy
                // In other case this falls into the recursive loop/stack exceeded caused by:
                // collectFrom() -> traverseSymbol() -> evaluateSymbolSql() ->
                // evaluateSql() -> resolveSymbolsCall() -> cubeReferenceProxy->toString() ->
                // evaluateSymbolSql() -> evaluateSql()... -> and got here again
                //
                // When FILTER_PARAMS is used in dimension/measure SQL - we also hit recursive loop:
                // allBackAliasMembersExceptSegments() -> collectFrom() -> traverseSymbol() -> evaluateSymbolSql() ->
                // autoPrefixAndEvaluateSql() -> evaluateSql() -> filterProxyFromAllFilters->Proxy->toString()
                // and so on...
                // For this case aliasGathering flag is added to the context in first iteration and
                // is checked below to prevent looping.
                const aliases = allFilters ?
                  allFilters
                    .map(v => (v.query && !v.query.safeEvaluateSymbolContext().aliasGathering ? v.query.allBackAliasMembersExceptSegments() : {}))
                    .reduce((a, b) => ({ ...a, ...b }), {})
                  : {};
                // Filtering aliases that somehow relate to this group member
                const groupMember = cubeEvaluator.pathFromArray([cubeNameObj.cube, propertyName]);
                const aliasesForGroupMembers = Object.entries(aliases)
                  .filter(([key, _value]) => key === groupMember)
                  .map(([_key, value]) => value);
                const filter = BaseQuery.findAndSubTreeForFilterGroup(
                  newGroupFilter({ operator: 'and', values: allFilters }),
                  [groupMember],
                  newGroupFilter,
                  aliasesForGroupMembers
                );

                return `(${BaseQuery.renderFilterParams(filter, [this], allocateParam, newGroupFilter, aliases)})`;
              }
            })
          })
        });
      }
    });
  }

  /**
   *
   * @param {boolean} excludeSegments
   * @returns {Array<BaseMeasure | BaseDimension | BaseSegment>}
   */
  flattenAllMembers(excludeSegments = false) {
    return R.flatten(
      this.measures
        .concat(this.dimensions)
        .concat(excludeSegments ? [] : this.segments)
        .concat(this.filters)
        .concat(this.measureFilters)
        .concat(this.timeDimensions)
        .map(m => m.getMembers()),
    );
  }

  /**
   * @returns {Record<string, string>}
   */
  allBackAliasTimeDimensions() {
    const members = R.flatten(this.timeDimensions.map(m => m.getMembers()));
    return this.backAliasMembers(members);
  }

  /**
   * @returns {Record<string, string>}
   */
  allBackAliasMembersExceptSegments() {
    return this.backAliasMembers(this.flattenAllMembers(true));
  }

  /**
   * @returns {Record<string, string>}
   */
  allBackAliasMembers() {
    return this.backAliasMembers(this.flattenAllMembers());
  }

  /**
   *
   * @param {Array<BaseMeasure | BaseDimension | BaseSegment>} members
   * @returns {Record<string, string>}
   */
  backAliasMembers(members) {
    const query = this;

    const aliases = Object.fromEntries(members.flatMap(
      member => {
        const collectedMembers = query.evaluateSymbolSqlWithContext(
          () => query.collectFrom([member], query.collectMemberNamesFor.bind(query), 'collectMemberNamesFor'),
          { aliasGathering: true }
        );
        const memberPath = member.expressionPath();
        let nonAliasSeen = false;
        return collectedMembers
          .filter(d => {
            if (!query.cubeEvaluator.byPathAnyType(d).aliasMember) {
              nonAliasSeen = true;
            }
            return !nonAliasSeen;
          })
          .map(d => [query.cubeEvaluator.byPathAnyType(d).aliasMember, memberPath]);
      }
    ));

    // No join/graph  might be in place when collecting members from the query with some injected filters,
    // like FILTER_PARAMS or securityContext...
    // So we simply return aliases as is
    if (!this.join || !this.joinGraphPaths) {
      return aliases;
    }

    const buildJoinPath = this.buildJoinPathFn();

    /**
     * @type {Record<string, string>}
     */
    const res = {};
    for (const [original, alias] of Object.entries(aliases)) {
      const [cube, field] = original.split('.');
      const path = buildJoinPath(cube);

      const [aliasCube, aliasField] = alias.split('.');
      const aliasPath = aliasCube !== cube ? buildJoinPath(aliasCube) : path;

      if (path) {
        res[`${path}.${field}`] = aliasPath ? `${aliasPath}.${aliasField}` : alias;
      }

      // Aliases might come from proxied members, in such cases
      // we need to map them to originals too
      if (aliasPath) {
        res[original] = `${aliasPath}.${aliasField}`;
      }
    }

    return res;
  }

  buildJoinPathFn() {
    const query = this;
    const { root } = this.join || {};

    return (target) => {
      const visited = new Set();
      const path = [];

      /**
       * @param {string} node
       * @returns {boolean}
       */
      function dfs(node) {
        if (node === target) {
          path.push(node);
          return true;
        }

        if (visited.has(node)) return false;
        visited.add(node);

        const neighbors = query.joinGraphPaths[node] || [];
        for (const neighbor of neighbors) {
          if (dfs(neighbor)) {
            path.unshift(node);
            return true;
          }
        }

        return false;
      }

      return (root && dfs(root)) ? path.join('.') : null;
    };
  }

  /**
   * Returns a function that constructs the full member path
   * based on the query's join structure.
   * @returns {(function(member: string): (string))}
   */
  resolveFullMemberPathFn() {
    const { root: queryJoinRoot } = this.join || {};

    const buildJoinPath = this.buildJoinPathFn();

    return (member) => {
      const [cube, field] = member.split('.');
      if (!cube || !field) return member;

      if (cube === queryJoinRoot?.root) {
        return member;
      }

      const path = buildJoinPath(cube);
      return path ? `${path}.${field}` : member;
    };
  }

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
  }

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
  }

  /**
   * 检查数据库是否支持 FILTER 语法
   * 默认为 true，子类可以重写
   *
   * @returns {boolean}
   */
  supportsFilterClause() {
    return true;
  }

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
  }

  measurePeriodAverageDefinition(measureDefinition) {
    if (!measureDefinition) {
      return null;
    }
    const meta = measureDefinition.meta;
    return measureDefinition.periodAverage
      || measureDefinition.period_average
      || (meta && typeof meta === 'object' && (meta.periodAverage || meta.period_average))
      || null;
  }

  isPeriodAverageMeasureDefinition(measureDefinition) {
    return !!this.measurePeriodAverageDefinition(measureDefinition);
  }

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
  }

  queryPeriodAverageMeasures(measures = this.measures) {
    return (measures || []).filter((m) => this.isPeriodAverageMeasure(m));
  }

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
  }

  semiAdditiveOuterSqlReferencesMainCubeAlias(sql) {
    return typeof sql === 'string' && /\bmain__\w+/i.test(sql);
  }

  periodAverageBaseMeasurePathFromDefinition(measureDefinition) {
    const periodAverage = this.measurePeriodAverageDefinition(measureDefinition);
    if (!periodAverage) {
      return null;
    }
    return periodAverage.baseMeasure || periodAverage.base_measure || null;
  }

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
  }

  periodAverageBaseMeasurePathsInQuery(measures = this.measures) {
    const paths = new Set();
    this.queryPeriodAverageMeasures(measures).forEach((measure) => {
      const basePath = this.periodAverageBaseMeasurePath(measure);
      if (basePath) {
        paths.add(basePath);
      }
    });
    return paths;
  }

  directSemiAdditiveMeasurePathsInQuery(measures = this.measures) {
    return new Set(
      (measures || [])
        .filter(m => typeof m.isSemiAdditive === 'function' && m.isSemiAdditive())
        .map(m => m.expressionPath && m.expressionPath())
        .filter(Boolean),
    );
  }

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
  }

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
  }

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
  }

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
  }

  /**
   * True if the current query lists any semi-additive measure (nonAdditiveDimension).
   * Used with `this.from` so multi-stage subqueries still run regularMeasuresSubQuery.
   */
  queryHasSemiAdditiveMeasures() {
    return (this.measures || []).some((m) => {
      const measurePath = m?.expressionPath && m.expressionPath();
      return measurePath && this.shouldUseSemiAdditiveAggregationForMeasurePath(measurePath);
    });
  }

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
  }

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
  }

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
        pushedDimensionPaths.add(path);
        // Project keys columns under flat aliases so windowed_data can reference them
        // (base_data has no `keys` table alias — only the projected column names).
        unaggregatedColumns.push(`${dimensionSourceAlias}.${d.aliasName()} as ${d.aliasName()}`);
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
  }

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
  }

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
    const cubeName = measure.cube().name;
    const symbol = measure.measureDefinition();
    const sql = symbol.sql && this.evaluateSql(cubeName, symbol.sql);
    return this.applyMeasureFilters(
      this.autoPrefixWithCubeName(cubeName, sql, false),
      symbol,
      cubeName,
    );
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  /**
   * windowChoice → MIN/MAX 聚合函数。
   *
   * @param {string} windowChoice
   * @returns {'MIN'|'MAX'}
   */
  semiAdditiveBoundaryAggFunc(windowChoice) {
    const ascendingChoices = ['first', 'min'];
    return ascendingChoices.includes(windowChoice) ? 'MIN' : 'MAX';
  }

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
  }

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
      const boundsAlias = `partition_bounds_${groupIndex}`;
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
        `${boundsAlias} AS (\n  SELECT ${selectParts.join(', ')}\n  FROM base_data${groupByClauseBounds}\n)`
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
      ...baseColumnAliases.map(a => `base_data.${a}`),
      ...boundarySelectAliases,
    ].join(', ');

    const cteQuery = `WITH base_data AS (
  ${originalQuery}
), ${boundsCteParts.join(',\n')}, matched_data AS (
  SELECT ${matchedSelect}
  FROM base_data
  ${joinClauses.join('\n  ')}
)
SELECT ${selectColumns} FROM matched_data${groupByClause}`;

    return cteQuery;
  }

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

    const baseColumnAliases = this.semiAdditiveBaseColumnAliases(baseColumns);
    const { selectColumns, groupByClause } = this.buildSemiAdditiveOuterSelect(
      measures,
      semiAdditiveMeasures,
      dimensionsForSemiAdditiveRemap,
    );

    return `WITH base_data AS (
  ${originalQuery}
), windowed_data AS (
  SELECT ${baseColumnAliases.join(', ')}, ${windowExpressions.join(', ')}
  FROM base_data
)
SELECT ${selectColumns} FROM windowed_data${groupByClause}`;
  }

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
  }

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
  }

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
  }

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
  }
}
