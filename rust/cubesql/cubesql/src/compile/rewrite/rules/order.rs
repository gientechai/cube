use std::{
    collections::HashSet,
    ops::{Index, IndexMut},
    sync::Arc,
};

use egg::{Id, Subst};

use crate::{
    compile::{
        datafusion::logical_plan::{Column, Expr},
        rewrite::{
            analysis::OriginalExpr,
            column_expr, column_name_to_member_vec,
            converter::LogicalPlanToLanguageConverter,
            cube_scan, cube_scan_order, cube_scan_order_empty_tail, expr_column_name, limit, order,
            order_replacer, projection, referenced_columns, rewrite,
            rewriter::{CubeEGraph, CubeRewrite, RewriteRules},
            sort, sort_exp, sort_exp_empty_tail, sort_expr, sort_projection_pullup_replacer,
            sort_projection_pushdown_replacer, transforming_chain_rewrite, transforming_rewrite,
            ColumnExprColumn, LogicalPlanLanguage, OrderAsc, OrderMember,
            OrderReplacerColumnNameToMember, ProjectionAlias, SortExprAsc, SortExprNullsFirst,
            SortProjectionPushdownReplacerColumnToExpr,
        },
    },
    config::ConfigObj,
    transport::MetaContext,
    var, var_iter,
};

pub struct OrderRules {
    meta_context: Arc<MetaContext>,
    config_obj: Arc<dyn ConfigObj>,
}

impl RewriteRules for OrderRules {
    fn rewrite_rules(&self) -> Vec<CubeRewrite> {
        vec![
            transforming_chain_rewrite(
                "mssql-null-order-project-grouped-scan",
                sort("?sort_expr", "?input"),
                vec![(
                    "?input",
                    cube_scan(
                        "?alias_to_cube",
                        "?members",
                        "?filters",
                        "?order",
                        "?limit",
                        "?offset",
                        "?split",
                        "?can_pushdown_join",
                        "CubeScanWrapped:false",
                        "CubeScanUngrouped:false",
                        "?join_hints",
                    ),
                )],
                sort(
                    "?sort_expr",
                    projection(
                        "?projection_expr",
                        "?input",
                        "?projection_alias",
                        "ProjectionSplit:false",
                    ),
                ),
                self.project_grouped_scan_for_null_order(),
            ),
            transforming_rewrite(
                "push-down-sort",
                sort(
                    "?expr",
                    cube_scan(
                        "?alias_to_cube",
                        "?members",
                        "?filters",
                        "CubeScanOrder",
                        "?limit",
                        "?offset",
                        "?split",
                        "?can_pushdown_join",
                        "CubeScanWrapped:false",
                        "?ungrouped",
                        "?join_hints",
                    ),
                ),
                cube_scan(
                    "?alias_to_cube",
                    "?members",
                    "?filters",
                    order_replacer("?expr", "?aliases"),
                    "?limit",
                    "?offset",
                    "?split",
                    "?can_pushdown_join",
                    "CubeScanWrapped:false",
                    "?ungrouped",
                    "?join_hints",
                ),
                self.push_down_sort("?expr", "?members", "?aliases"),
            ),
            transforming_rewrite(
                "order-replacer",
                order_replacer(
                    sort_exp(
                        sort_expr("?expr", "?asc", "?nulls_first"),
                        "?tail_group_expr",
                    ),
                    "?aliases",
                ),
                cube_scan_order(
                    order("?order_member", "?order_asc"),
                    order_replacer("?tail_group_expr", "?aliases"),
                ),
                self.transform_order(
                    "?expr",
                    "?asc",
                    "?nulls_first",
                    "?aliases",
                    "?order_member",
                    "?order_asc",
                ),
            ),
            rewrite(
                "order-replacer-tail-proj",
                order_replacer(sort_exp_empty_tail(), "?aliases"),
                cube_scan_order_empty_tail(),
            ),
            // TODO: refactor this rule to `push-down-sort-projection`,
            // possibly adjust cost function to penalize Limit-...-Sort plan
            transforming_chain_rewrite(
                "push-down-limit-sort-projection",
                limit("?skip", "?fetch", sort("?sort_expr", "?projection")),
                vec![(
                    // Avoid recursion when projection input is self
                    "?projection",
                    projection(
                        "?projection_expr",
                        "?input",
                        "?projection_alias",
                        "?projection_split",
                    ),
                )],
                projection(
                    "?projection_expr",
                    limit(
                        "?skip",
                        "?fetch",
                        sort(
                            sort_projection_pushdown_replacer("?sort_expr", "?column_to_expr"),
                            "?input",
                        ),
                    ),
                    "?projection_alias",
                    "?projection_split",
                ),
                self.push_down_limit_sort_projection(
                    "?input",
                    "?projection_expr",
                    "?projection_alias",
                    "?column_to_expr",
                ),
            ),
            rewrite(
                "sort-projection-replacer-pull-up-sort",
                sort(sort_projection_pullup_replacer("?expr"), "?input"),
                sort("?expr", "?input"),
            ),
            rewrite(
                "sort-projection-replacer-push-down-sortexp",
                sort_projection_pushdown_replacer(sort_exp("?left", "?right"), "?column_to_expr"),
                sort_exp(
                    sort_projection_pushdown_replacer("?left", "?column_to_expr"),
                    sort_projection_pushdown_replacer("?right", "?column_to_expr"),
                ),
            ),
            rewrite(
                "sort-projection-replacer-push-down-sortexp-tail",
                sort_projection_pushdown_replacer(sort_exp_empty_tail(), "?column_to_expr"),
                sort_projection_pullup_replacer(sort_exp_empty_tail()),
            ),
            rewrite(
                "sort-projection-replacer-pull-up-sortexp",
                sort_exp(
                    sort_projection_pullup_replacer("?left"),
                    sort_projection_pullup_replacer("?right"),
                ),
                sort_projection_pullup_replacer(sort_exp("?left", "?right")),
            ),
            rewrite(
                "sort-projection-replacer-push-down-sortexpr",
                sort_projection_pushdown_replacer(
                    sort_expr("?expr", "?asc", "?nulls_first"),
                    "?column_to_expr",
                ),
                sort_expr(
                    sort_projection_pushdown_replacer("?expr", "?column_to_expr"),
                    "?asc",
                    "?nulls_first",
                ),
            ),
            rewrite(
                "sort-projection-replacer-pull-up-sortexpr",
                sort_expr(
                    sort_projection_pullup_replacer("?expr"),
                    "?asc",
                    "?nulls_first",
                ),
                sort_projection_pullup_replacer(sort_expr("?expr", "?asc", "?nulls_first")),
            ),
            transforming_rewrite(
                "sort-projection-replacer-push-down-column",
                sort_projection_pushdown_replacer(column_expr("?column"), "?column_to_expr"),
                sort_projection_pullup_replacer("?new_expr"),
                self.sort_projection_replacer_push_down_column(
                    "?column",
                    "?column_to_expr",
                    "?new_expr",
                ),
            ),
        ]
    }
}

impl OrderRules {
    pub fn new(meta_context: Arc<MetaContext>, config_obj: Arc<dyn ConfigObj>) -> Self {
        Self {
            meta_context,
            config_obj,
        }
    }

    pub(crate) fn non_default_null_sort_exprs(egraph: &CubeEGraph, root: Id) -> Vec<Expr> {
        let mut pending = vec![root];
        let mut visited = HashSet::new();
        let mut expressions = Vec::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            for node in &egraph[id].nodes {
                match node {
                    LogicalPlanLanguage::SortExp(children) => pending.extend(children),
                    LogicalPlanLanguage::SortExpr([expr, asc, nulls_first]) => {
                        let opposite = var_iter!(egraph[*asc], SortExprAsc).any(|asc| {
                            var_iter!(egraph[*nulls_first], SortExprNullsFirst)
                                .any(|nulls_first| asc != nulls_first)
                        });
                        if opposite {
                            if let Some(OriginalExpr::Expr(expr)) =
                                &egraph[*expr].data.original_expr
                            {
                                expressions.push(expr.clone());
                            }
                        }
                    }
                    _ => (),
                }
            }
        }
        expressions
    }

    fn project_grouped_scan_for_null_order(&self) -> impl Fn(&mut CubeEGraph, &mut Subst) -> bool {
        let meta = self.meta_context.clone();
        let flat_list = self.config_obj.push_down_pull_up_split();
        move |egraph, subst| {
            let Some(mut members) = egraph[subst[var!("?members")]]
                .data
                .member_name_to_expr
                .clone()
            else {
                return false;
            };
            let order = Self::non_default_null_sort_exprs(egraph, subst[var!("?sort_expr")]);
            let aliases = column_name_to_member_vec(&mut members);
            let needs_wrapper = order.iter().any(|expr| {
                let name = expr_column_name(expr, &None);
                aliases
                    .iter()
                    .find(|(column, _)| column == &name)
                    .and_then(|(_, member)| member.as_ref())
                    .and_then(|member| meta.member_to_data_source.get(member))
                    .and_then(|source| meta.data_source_to_sql_generator.get(source))
                    .map(|generator| {
                        generator
                            .get_sql_templates()
                            .templates
                            .get("capabilities/mssql_2016_compat")
                            .map(|value| value == "true")
                            .unwrap_or(false)
                    })
                    .unwrap_or(false)
            });
            if !needs_wrapper
                || members.list.is_empty()
                || members
                    .list
                    .iter()
                    .any(|(_, _, expr)| !matches!(expr, Expr::Column(_)))
            {
                return false;
            }
            // DISTINCT dimensions can collapse to a bare grouped scan. Retain an
            // identity projection so the existing wrapper can carry SQL ordering.
            let mut columns = Vec::new();
            for (_, _, expr) in &members.list {
                let Ok(column) = LogicalPlanToLanguageConverter::add_expr(egraph, expr, flat_list)
                else {
                    return false;
                };
                columns.push(column);
            }
            let projection = if flat_list {
                egraph.add(LogicalPlanLanguage::ProjectionExpr(columns))
            } else {
                let mut tail = egraph.add(LogicalPlanLanguage::ProjectionExpr(vec![]));
                for column in columns.into_iter().rev() {
                    tail = egraph.add(LogicalPlanLanguage::ProjectionExpr(vec![column, tail]));
                }
                tail
            };
            subst.insert(var!("?projection_expr"), projection);
            subst.insert(
                var!("?projection_alias"),
                egraph.add(LogicalPlanLanguage::ProjectionAlias(ProjectionAlias(None))),
            );
            true
        }
    }

    fn push_down_sort(
        &self,
        sort_exp_var: &'static str,
        members_var: &'static str,
        aliases_var: &'static str,
    ) -> impl Fn(&mut CubeEGraph, &mut Subst) -> bool {
        let sort_exp_var = var!(sort_exp_var);
        let members_var = var!(members_var);
        let aliases_var = var!(aliases_var);
        move |egraph, subst| {
            if let Some(referenced_expr) = &egraph.index(subst[sort_exp_var]).data.referenced_expr {
                if egraph
                    .index(subst[members_var])
                    .data
                    .member_name_to_expr
                    .is_some()
                {
                    let referenced_columns = referenced_columns(referenced_expr);
                    if let Some(member_name_to_expr) = &mut egraph
                        .index_mut(subst[members_var])
                        .data
                        .member_name_to_expr
                    {
                        let column_name_to_member_name =
                            column_name_to_member_vec(member_name_to_expr);

                        if referenced_columns
                            .iter()
                            .all(|c| column_name_to_member_name.iter().any(|(cn, _)| cn == c))
                        {
                            subst.insert(
                                aliases_var,
                                egraph.add(LogicalPlanLanguage::OrderReplacerColumnNameToMember(
                                    OrderReplacerColumnNameToMember(column_name_to_member_name),
                                )),
                            );
                            return true;
                        }
                    }
                }
            }
            false
        }
    }

    fn transform_order(
        &self,
        expr_var: &'static str,
        asc_var: &'static str,
        nulls_first_var: &'static str,
        column_name_to_member_var: &'static str,
        order_member_var: &'static str,
        order_asc_var: &'static str,
    ) -> impl Fn(&mut CubeEGraph, &mut Subst) -> bool {
        let expr_var = expr_var.parse().unwrap();
        let asc_var = asc_var.parse().unwrap();
        let nulls_first_var = nulls_first_var.parse().unwrap();
        let column_name_to_member_var = column_name_to_member_var.parse().unwrap();
        let order_member_var = order_member_var.parse().unwrap();
        let order_asc_var = order_asc_var.parse().unwrap();
        let meta_context = self.meta_context.clone();
        move |egraph, subst| {
            if let Some(OriginalExpr::Expr(expr)) =
                egraph[subst[expr_var]].data.original_expr.clone()
            {
                let column_name = expr_column_name(&expr, &None);
                let nulls_first = var_iter!(egraph[subst[nulls_first_var]], SortExprNullsFirst)
                    .copied()
                    .collect::<Vec<_>>();
                for asc in var_iter!(egraph[subst[asc_var]], SortExprAsc) {
                    let asc = *asc;
                    for column_name_to_member in var_iter!(
                        egraph[subst[column_name_to_member_var]],
                        OrderReplacerColumnNameToMember
                    ) {
                        if let Some((_, Some(member_name))) = column_name_to_member
                            .iter()
                            .find(|(c, _)| c == &column_name)
                        {
                            let nulls_are_smallest = meta_context
                                .member_to_data_source
                                .get(member_name)
                                .and_then(|source| {
                                    meta_context.data_source_to_sql_generator.get(source)
                                })
                                .map(|generator| {
                                    generator
                                        .get_sql_templates()
                                        .templates
                                        .get("capabilities/mssql_2016_compat")
                                        .map(|value| value == "true")
                                        .unwrap_or(false)
                                })
                                .unwrap_or(false);
                            // Cube's member/direction order representation cannot preserve
                            // a non-default NULL position. Keep the SQL wrapper in that case.
                            if nulls_are_smallest && nulls_first.as_slice() != [asc].as_slice() {
                                continue;
                            }
                            let member_name = member_name.to_string();
                            subst.insert(
                                order_member_var,
                                egraph.add(LogicalPlanLanguage::OrderMember(OrderMember(
                                    member_name.to_string(),
                                ))),
                            );

                            subst.insert(
                                order_asc_var,
                                egraph.add(LogicalPlanLanguage::OrderAsc(OrderAsc(asc))),
                            );
                            return true;
                        }
                    }
                }
            }

            false
        }
    }

    fn push_down_limit_sort_projection(
        &self,
        input_var: &'static str,
        projection_expr_var: &'static str,
        projection_alias_var: &'static str,
        column_to_expr_var: &'static str,
    ) -> impl Fn(&mut CubeEGraph, &mut Subst) -> bool {
        let input_var = var!(input_var);
        let projection_expr_var = var!(projection_expr_var);
        let projection_alias_var = var!(projection_alias_var);
        let column_to_expr_var = var!(column_to_expr_var);
        move |egraph, subst| {
            let input_is_sort_or_limit = egraph[subst[input_var]].nodes.iter().any(|node| {
                matches!(
                    node,
                    LogicalPlanLanguage::Sort(_) | LogicalPlanLanguage::Limit(_)
                )
            });
            if input_is_sort_or_limit {
                return false;
            }

            let Some(expr_to_alias) = egraph[subst[projection_expr_var]]
                .data
                .expr_to_alias
                .as_deref()
            else {
                return false;
            };

            for projection_alias in var_iter!(egraph[subst[projection_alias_var]], ProjectionAlias)
            {
                let mut column_to_expr = vec![];
                for (expr, alias, _) in expr_to_alias {
                    let column = Column::from_name(alias);
                    column_to_expr.push((column, expr.clone()));
                    if let Some(projection_alias) = projection_alias.as_deref() {
                        let column = Column {
                            relation: Some(projection_alias.to_string()),
                            name: alias.to_string(),
                        };
                        column_to_expr.push((column, expr.clone()));
                    }
                }

                subst.insert(
                    column_to_expr_var,
                    egraph.add(
                        LogicalPlanLanguage::SortProjectionPushdownReplacerColumnToExpr(
                            SortProjectionPushdownReplacerColumnToExpr(column_to_expr),
                        ),
                    ),
                );
                return true;
            }
            false
        }
    }

    fn sort_projection_replacer_push_down_column(
        &self,
        column_var: &'static str,
        column_to_expr_var: &'static str,
        new_expr_var: &'static str,
    ) -> impl Fn(&mut CubeEGraph, &mut Subst) -> bool {
        let column_var = var!(column_var);
        let column_to_expr_var = var!(column_to_expr_var);
        let new_expr_var = var!(new_expr_var);
        let flat_list = self.config_obj.push_down_pull_up_split();
        move |egraph, subst| {
            for old_column in var_iter!(egraph[subst[column_var]], ColumnExprColumn).cloned() {
                for column_to_expr in var_iter!(
                    egraph[subst[column_to_expr_var]],
                    SortProjectionPushdownReplacerColumnToExpr
                )
                .cloned()
                {
                    let Some(expr) = column_to_expr.iter().find_map(|(column, expr)| {
                        if column == &old_column {
                            Some(expr)
                        } else {
                            None
                        }
                    }) else {
                        continue;
                    };

                    // TODO: workaround the issue with `generate_sql_for_push_to_cube`
                    // accepting only columns and erroring on more complex expressions.
                    // Remove this when `generate_sql_for_push_to_cube` is fixed.
                    if !matches!(expr, Expr::Column(_)) {
                        continue;
                    }

                    let Ok(new_expr_id) =
                        LogicalPlanToLanguageConverter::add_expr(egraph, expr, flat_list)
                    else {
                        // Insertion failure should never happen as it can be partial,
                        // so fail right away.
                        return false;
                    };

                    subst.insert(new_expr_var, new_expr_id);
                    return true;
                }
            }
            false
        }
    }
}
