use super::Visitor;
use datafusion::error::DataFusionError;
use sqlparser::ast::{self, ObjectName};

/// Validate before UDF type inference, but only when every physical relation is
/// known to be MSSQL. The shared UDFs and all other dialects keep their behavior.
pub fn validate_function_arguments(
    statement: &ast::Statement,
    is_mssql_table: impl Fn(&ObjectName) -> bool,
) -> Result<(), DataFusionError> {
    let mut visitor = MssqlQueryVisitor {
        is_mssql_table,
        cte_scopes: vec![],
        has_mssql_table: false,
        has_other_table: false,
        empty_function: None,
    };
    visitor.visit_statement(&mut statement.clone())?;
    if visitor.has_mssql_table && !visitor.has_other_table {
        if let Some(name) = visitor.empty_function {
            return Err(DataFusionError::Plan(format!(
                "{} requires at least one argument",
                name
            )));
        }
    }
    Ok(())
}

struct MssqlQueryVisitor<F> {
    is_mssql_table: F,
    cte_scopes: Vec<Vec<String>>,
    has_mssql_table: bool,
    has_other_table: bool,
    empty_function: Option<String>,
}

impl<'ast, F: Fn(&ObjectName) -> bool> Visitor<'ast, DataFusionError> for MssqlQueryVisitor<F> {
    fn visit_select(&mut self, select: &mut Box<ast::Select>) -> Result<(), DataFusionError> {
        // These dialect-specific clauses are not visited by the common walker.
        // Leave such queries on their original validation path conservatively.
        if select.top.is_some()
            || select.into.is_some()
            || !select.lateral_views.is_empty()
            || !select.cluster_by.is_empty()
            || !select.distribute_by.is_empty()
            || !select.sort_by.is_empty()
        {
            self.has_other_table = true;
        }
        for item in &mut select.projection {
            self.visit_select_item(item)?;
        }
        for from in &mut select.from {
            self.visit_table_with_joins(from)?;
        }
        for expr in select
            .selection
            .iter_mut()
            .chain(select.having.iter_mut())
            .chain(select.group_by.iter_mut())
        {
            self.visit_expr(expr)?;
        }
        Ok(())
    }

    fn visit_query(&mut self, query: &mut Box<ast::Query>) -> Result<(), DataFusionError> {
        self.cte_scopes.push(vec![]);
        if let Some(with) = &mut query.with {
            for cte in &mut with.cte_tables {
                if cte.from.is_some() {
                    self.has_other_table = true;
                }
                let name = cte.alias.name.value.to_ascii_lowercase();
                // Non-recursive CTE bodies resolve names in the outer scope.
                if with.recursive {
                    self.cte_scopes.last_mut().unwrap().push(name.clone());
                }
                self.visit_query(&mut cte.query)?;
                if !with.recursive {
                    self.cte_scopes.last_mut().unwrap().push(name);
                }
            }
        }
        self.visit_set_expr(&mut query.body)?;
        for order in &mut query.order_by {
            self.visit_expr(&mut order.expr)?;
        }
        if let Some(limit) = &mut query.limit {
            self.visit_expr(limit)?;
        }
        if let Some(offset) = &mut query.offset {
            self.visit_expr(&mut offset.value)?;
        }
        if let Some(quantity) = query
            .fetch
            .as_mut()
            .and_then(|fetch| fetch.quantity.as_mut())
        {
            self.visit_expr(quantity)?;
        }
        self.cte_scopes.pop();
        Ok(())
    }

    fn visit_table_factor(&mut self, factor: &mut ast::TableFactor) -> Result<(), DataFusionError> {
        match factor {
            ast::TableFactor::Table {
                name,
                args,
                with_hints,
                ..
            } => {
                let is_cte = name.0.len() == 1
                    && self.cte_scopes.iter().rev().any(|scope| {
                        scope
                            .iter()
                            .any(|cte| cte.eq_ignore_ascii_case(&name.0[0].value))
                    });
                if !is_cte {
                    if args.is_empty() && (self.is_mssql_table)(name) {
                        self.has_mssql_table = true;
                    } else {
                        self.has_other_table = true;
                    }
                }
                self.visit_function_args(args)?;
                for hint in with_hints {
                    self.visit_expr(hint)?;
                }
            }
            ast::TableFactor::Derived { subquery, .. } => self.visit_query(subquery)?,
            ast::TableFactor::NestedJoin(join) => self.visit_table_with_joins(join)?,
            ast::TableFactor::TableFunction { expr, .. } => {
                self.has_other_table = true;
                self.visit_expr(expr)?;
            }
        }
        Ok(())
    }

    fn visit_function(&mut self, function: &mut ast::Function) -> Result<(), DataFusionError> {
        let name = function
            .name
            .0
            .iter()
            .map(|part| part.value.to_ascii_uppercase())
            .collect::<Vec<_>>()
            .join(".");
        if function.args.is_empty()
            && matches!(
                name.as_str(),
                "LEAST" | "GREATEST" | "PG_CATALOG.LEAST" | "PG_CATALOG.GREATEST"
            )
        {
            self.empty_function = Some(name);
        }
        self.visit_function_args(&mut function.args)?;
        if let Some(over) = &mut function.over {
            for expr in &mut over.partition_by {
                self.visit_expr(expr)?;
            }
            for order in &mut over.order_by {
                self.visit_expr(&mut order.expr)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlparser::{dialect::PostgreSqlDialect, parser::Parser};

    fn validate(sql: &str) -> Result<(), DataFusionError> {
        let statement = Parser::parse_sql(&PostgreSqlDialect {}, sql)
            .unwrap()
            .remove(0);
        validate_function_arguments(&statement, |name| {
            name.to_string().eq_ignore_ascii_case("Sales")
        })
    }

    #[test]
    fn test_mssql_only_argument_validation() {
        for sql in [
            "SELECT LEAST() FROM Sales",
            "SELECT COALESCE(GREATEST(), 1) FROM Sales",
            "SELECT \"least\"() FROM Sales",
            "SELECT id FROM Sales ORDER BY LEAST()",
            "SELECT LEAST() FROM (SELECT id FROM Sales) s",
            "WITH s AS (SELECT id FROM Sales) SELECT GREATEST() FROM s",
            "SELECT id FROM Sales WHERE id IN (SELECT GREATEST() FROM Sales)",
            "WITH Sales AS (SELECT id FROM Sales) SELECT LEAST() FROM Sales",
        ] {
            assert!(
                validate(sql)
                    .unwrap_err()
                    .to_string()
                    .contains("requires at least one argument"),
                "{}",
                sql
            );
        }
        // Tenant metadata may contain MSSQL, but these statements must not use
        // its validation. Unknown sources and mixed queries are conservative.
        for sql in [
            "SELECT LEAST()",
            "SELECT GREATEST() FROM PostgresSales",
            "SELECT LEAST() FROM UnknownSales",
            "SELECT LEAST() FROM Sales JOIN PostgresSales p ON Sales.id = p.id",
            "SELECT LEAST() FROM Sales WHERE id IN (SELECT id FROM PostgresSales)",
            "WITH Sales AS (SELECT id FROM PostgresSales) SELECT LEAST() FROM Sales",
            "SELECT LEAST() FROM Sales UNION ALL SELECT id FROM PostgresSales",
            "SELECT LEAST(id, 1), GREATEST(id, 1) FROM Sales",
        ] {
            assert!(validate(sql).is_ok(), "{}", sql);
        }
    }
}
