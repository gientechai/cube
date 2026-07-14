use super::SqlNode;
use crate::physical_plan::SqlEvaluatorVisitor;
use crate::planner::query_tools::QueryTools;
use crate::planner::sql_templates::PlanSqlTemplates;
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use std::any::Any;
use std::rc::Rc;

/// Renders period_average measures as `{AGG}(base) / NULLIF(divisor, 0)`.
pub struct PeriodAverageMeasureNode {
    input: Rc<dyn SqlNode>,
    default_processor: Rc<dyn SqlNode>,
}

impl PeriodAverageMeasureNode {
    pub fn new(input: Rc<dyn SqlNode>, default_processor: Rc<dyn SqlNode>) -> Rc<Self> {
        Rc::new(Self {
            input,
            default_processor,
        })
    }
}

impl SqlNode for PeriodAverageMeasureNode {
    fn to_sql(
        &self,
        visitor: &SqlEvaluatorVisitor,
        node: &Rc<MemberSymbol>,
        query_tools: Rc<QueryTools>,
        node_processor: Rc<dyn SqlNode>,
        templates: &PlanSqlTemplates,
    ) -> Result<String, CubeError> {
        let res = match node.as_ref() {
            MemberSymbol::Measure(m) if m.is_period_average() => {
                let period_average = m
                    .period_average()
                    .ok_or_else(|| CubeError::internal("Missing period_average config".to_string()))?;
                let base_measure = period_average
                    .base_measure
                    .as_ref()
                    .ok_or_else(|| {
                        CubeError::user(format!(
                            "period_average measure '{}' is missing baseMeasure",
                            m.full_name()
                        ))
                    })?;
                let base_symbol = query_tools.resolve_measure(base_measure)?;
                let numerator = templates.period_average_numerator(
                    self.default_processor.to_sql(
                        visitor,
                        &base_symbol,
                        query_tools.clone(),
                        node_processor.clone(),
                        templates,
                    )?,
                    period_average.avg_unit.clone(),
                    period_average.interval.clone(),
                    period_average.time_dimension.clone(),
                    None,
                )?;
                let divisor = templates.period_average_divisor(
                    period_average.avg_unit.clone(),
                    period_average.interval.clone(),
                    period_average.denominator.clone(),
                    period_average.time_dimension.clone(),
                    None,
                    false,
                )?;
                format!("({}) / NULLIF({}, 0)", numerator, divisor)
            }
            MemberSymbol::Measure(_) => self.default_processor.to_sql(
                visitor,
                node,
                query_tools,
                node_processor,
                templates,
            )?,
            _ => {
                return Err(CubeError::internal(
                    "Unexpected evaluation node type for PeriodAverageMeasureNode".to_string(),
                ));
            }
        };
        Ok(res)
    }

    fn as_any(self: Rc<Self>) -> Rc<dyn Any> {
        self
    }

    fn childs(&self) -> Vec<Rc<dyn SqlNode>> {
        vec![self.input.clone()]
    }
}
