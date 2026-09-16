use super::FullKeyAggregateStrategy;
use crate::logical_plan::{FullKeyAggregate, LogicalJoin, MultiStageSubqueryRef};
use crate::physical_plan::sql_nodes::SqlNodesFactory;
use crate::physical_plan::{
    Expr, From, FromSource, JoinBuilder, JoinCondition, QualifiedColumnName, Select,
    SelectBuilder, SingleAliasedSource,
};
use crate::physical_plan_builder::PhysicalPlanBuilder;
use crate::physical_plan_builder::PushDownBuilderContext;
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use std::rc::Rc;

/// Mirrors `BaseQuery.outerMeasuresJoinFullKeyQueryAggregate` for dialects
/// without FULL JOIN: regular (leaf) measure CTEs anchor `q_0`, non-regular
/// branches INNER JOIN each other, and multi-stage outputs LEFT JOIN back to
/// `q_0` on the query grain. Avoids the UNION-keys path that can fail to
/// match leaf measures when non-time dimensions are present.
pub(super) struct RegularFirstFullKeyAggregateStrategy<'a> {
    builder: &'a PhysicalPlanBuilder,
}

impl<'a> RegularFirstFullKeyAggregateStrategy<'a> {
    pub fn new(builder: &'a PhysicalPlanBuilder) -> Rc<Self> {
        Rc::new(Self { builder })
    }

    pub fn should_use(full_key_aggregate: &FullKeyAggregate) -> bool {
        if !full_key_aggregate.schema().has_dimensions() {
            return false;
        }
        let refs = full_key_aggregate.multi_stage_subquery_refs();
        if refs.len() < 2 {
            return false;
        }
        let has_regular = refs.iter().any(|r| !is_multi_stage_output_ref(r.as_ref()));
        let has_multi_stage = refs.iter().any(|r| is_multi_stage_output_ref(r.as_ref()));
        has_regular && has_multi_stage
    }
}

fn is_multi_stage_output_ref(multi_stage_ref: &MultiStageSubqueryRef) -> bool {
    multi_stage_ref
        .symbols()
        .iter()
        .any(|symbol| symbol.is_multi_stage())
}

fn dimension_join_conditions(
    dimensions: &[Rc<MemberSymbol>],
    left_alias: &str,
    left_query: &Rc<Select>,
    right_alias: &str,
    right_query: &Rc<Select>,
) -> Result<Vec<Vec<(Expr, Expr)>>, CubeError> {
    dimensions
        .iter()
        .map(|dim| {
            let alias_in_left = left_query.schema().resolve_member_alias(dim);
            let left_ref = Expr::Reference(QualifiedColumnName::new(
                Some(left_alias.to_string()),
                alias_in_left,
            ));
            let alias_in_right = right_query.schema().resolve_member_alias(dim);
            let right_ref = Expr::Reference(QualifiedColumnName::new(
                Some(right_alias.to_string()),
                alias_in_right,
            ));
            Ok(vec![(left_ref, right_ref)])
        })
        .collect()
}

impl FullKeyAggregateStrategy for RegularFirstFullKeyAggregateStrategy<'_> {
    fn process(
        &self,
        full_key_aggregate: &FullKeyAggregate,
        context: &PushDownBuilderContext,
    ) -> Result<Rc<From>, CubeError> {
        let query_tools = self.builder.query_tools();
        let mut data_queries: Vec<(Rc<Select>, Rc<MultiStageSubqueryRef>)> = vec![];

        for multi_stage_ref in full_key_aggregate.multi_stage_subquery_refs().iter() {
            let multi_stage_schema = context.get_multi_stage_schema(multi_stage_ref.name())?;
            let multi_stage_source = SingleAliasedSource::new_from_table_reference(
                multi_stage_ref.name().clone(),
                multi_stage_schema.clone(),
                None,
            );
            let data_select = Rc::new(
                SelectBuilder::new(From::new(FromSource::Single(multi_stage_source)))
                    .build(query_tools.clone(), SqlNodesFactory::new()),
            );
            data_queries.push((data_select, multi_stage_ref.clone()));
        }

        if data_queries.is_empty() {
            let empty_join = LogicalJoin::builder().build();
            return self.builder.process_node(&empty_join, context);
        }

        if data_queries.len() == 1 {
            let (select, _) = data_queries.into_iter().next().unwrap();
            return Ok(From::new_from_subselect(select, "fk_aggregate".to_string()));
        }

        // Leaf regular refs first, then multi-stage outputs — same ordering as BaseQuery.toJoin.
        data_queries.sort_by_key(|(_, subquery_ref)| is_multi_stage_output_ref(subquery_ref.as_ref()));

        let dimensions: Vec<Rc<MemberSymbol>> = full_key_aggregate
            .schema()
            .all_dimensions()
            .cloned()
            .collect();

        let (anchor_query, _) = data_queries[0].clone();
        let anchor_alias = "q_0".to_string();
        let mut join_builder =
            JoinBuilder::new_from_subselect(anchor_query.clone(), anchor_alias.clone());

        let mut last_regular_query = anchor_query.clone();
        let mut last_regular_alias = anchor_alias.clone();

        for (idx, (query, subquery_ref)) in data_queries.into_iter().enumerate().skip(1) {
            let query_alias = format!("q_{idx}");
            if is_multi_stage_output_ref(subquery_ref.as_ref()) {
                let conditions = dimension_join_conditions(
                    &dimensions,
                    &anchor_alias,
                    &anchor_query,
                    &query_alias,
                    &query,
                )?;
                join_builder.left_join_subselect(
                    query,
                    query_alias,
                    JoinCondition::new_dimension_join(conditions, true),
                );
            } else {
                let conditions = dimension_join_conditions(
                    &dimensions,
                    &last_regular_alias,
                    &last_regular_query,
                    &query_alias,
                    &query,
                )?;
                join_builder.inner_join_subselect(
                    query.clone(),
                    query_alias.clone(),
                    JoinCondition::new_dimension_join(conditions, true),
                );
                last_regular_query = query;
                last_regular_alias = query_alias;
            }
        }

        Ok(From::new_from_join(join_builder.build()))
    }
}
